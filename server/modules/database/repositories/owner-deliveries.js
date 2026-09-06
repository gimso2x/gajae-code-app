import { createHash, randomBytes } from 'node:crypto';

import { getConnection } from '../connection.js';

export const DELIVERY_LEASE_MS = 60_000;
export const DELIVERY_MAX_ATTEMPTS = 8;
export const DELIVERY_BACKOFF_MS = 5_000;
export const DELIVERY_BACKOFF_CAP_MS = 3_600_000;
export const DELIVERY_RETRY_AFTER_MAX_SECONDS = 86400;
const digest = (value) => createHash('sha256').update(value).digest('hex');

export function createOwnerDeliveryRepository(connection = getConnection) {
  const database = () => {
    const db = connection();
    db.exec(`CREATE TABLE IF NOT EXISTS owner_deliveries (
      uid TEXT NOT NULL, project TEXT NOT NULL, source TEXT NOT NULL, event_id TEXT NOT NULL,
      installation TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      due INTEGER NOT NULL DEFAULT 0, deadline INTEGER, claim TEXT, token_hash TEXT, outcome TEXT,
      PRIMARY KEY(uid, project, source, event_id, installation)
    )`);
    return db;
  };
  const tablesReady = (db) => db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('owner_events','owner_devices')").get().n === 2;
  const currentDevice = (db, row) => db.prepare(`SELECT fcm_token, revoked, settings FROM owner_devices
    WHERE uid=@uid AND project=@project AND installation=@installation`).get({ uid: row.uid, project: row.project, installation: row.installation });
  const eligible = (device, source) => device && !device.revoked && device.fcm_token && JSON.parse(device.settings)[source] === true;
  return {
    claim(scope, limit, now) {
      const db = database();
      return db.transaction(() => {
        if (!tablesReady(db)) return [];
        // Intake is immutable and never marked delivered. Late device registration
        // remains eligible; the unique obligation key prevents rematerialization.
        db.prepare(`INSERT OR IGNORE INTO owner_deliveries (uid,project,source,event_id,installation)
          SELECT e.uid,e.project,e.source,e.event_id,d.installation FROM owner_events e
          JOIN owner_devices d ON d.uid=e.uid AND d.project=e.project
          WHERE e.uid=@uid AND e.project=@project AND e.source=@source AND e.status='pending'
          AND d.revoked=0 AND d.fcm_token IS NOT NULL AND json_extract(d.settings, '$.' || e.source)=1
          AND NOT EXISTS (SELECT 1 FROM owner_deliveries q WHERE q.uid=e.uid AND q.project=e.project
            AND q.source=e.source AND q.event_id=e.event_id AND q.installation=d.installation)
          ORDER BY e.rowid,d.installation LIMIT @limit`).run({ ...scope, limit });
        const rows = db.prepare(`SELECT * FROM owner_deliveries WHERE uid=@uid AND project=@project AND source=@source
          AND status IN ('pending','claimed') AND due<=@now ORDER BY due,rowid LIMIT @limit`).all({ ...scope, now, limit });
        const claims = [];
        for (const row of rows) {
          const key = { uid: row.uid, project: row.project, source: row.source, eventId: row.event_id, installation: row.installation };
          const device = currentDevice(db, row);
          if (!eligible(device, row.source) || row.attempts >= DELIVERY_MAX_ATTEMPTS) {
            db.prepare(`UPDATE owner_deliveries SET status='terminal', outcome=@outcome, claim=NULL, deadline=NULL
              WHERE uid=@uid AND project=@project AND source=@source AND event_id=@eventId AND installation=@installation`)
              .run({ ...key, outcome: row.attempts >= DELIVERY_MAX_ATTEMPTS ? 'exhausted' : 'skipped' });
            continue;
          }
          const claimToken = randomBytes(32).toString('base64url');
          const deadline = now + DELIVERY_LEASE_MS;
          db.prepare(`UPDATE owner_deliveries SET status='claimed', attempts=attempts+1, due=@deadline,
            deadline=@deadline, claim=@claim, token_hash=@tokenHash WHERE uid=@uid AND project=@project
            AND source=@source AND event_id=@eventId AND installation=@installation`)
            .run({ ...key, deadline, claim: claimToken, tokenHash: digest(device.fcm_token) });
          const event = JSON.parse(db.prepare(`SELECT envelope FROM owner_events WHERE uid=@uid AND project=@project
            AND source=@source AND event_id=@eventId`).get({ uid: key.uid, project: key.project, source: key.source, eventId: key.eventId }).envelope);
          claims.push({ event, installationId: row.installation, fcmToken: device.fcm_token, claimToken, deadline, attempt: row.attempts + 1 });
        }
        return claims;
      }).immediate();
    },
    renew(scope, input, now) {
      const db = database();
      return db.transaction(() => db.prepare(`UPDATE owner_deliveries SET deadline=@deadline,due=@deadline
        WHERE uid=@uid AND project=@project AND source=@source AND event_id=@eventId AND installation=@installation
        AND status='claimed' AND claim=@claimToken AND deadline>@now AND deadline<=@latest`)
        .run({ ...scope, eventId: input.eventId, installation: input.installationId, claimToken: input.claimToken,
          now, deadline: now + DELIVERY_LEASE_MS, latest: now + DELIVERY_LEASE_MS }).changes === 1).immediate();
    },
    isSendable(scope, input, now) {
      const db = database();
      const row = db.prepare(`SELECT * FROM owner_deliveries WHERE uid=@uid AND project=@project
        AND source=@source AND event_id=@eventId AND installation=@installation`)
        .get({ ...scope, eventId: input.eventId, installation: input.installationId });
      if (!row || row.status !== 'claimed' || row.claim !== input.claimToken || now >= row.deadline
        || now < row.deadline - DELIVERY_LEASE_MS) return false;
      const device = currentDevice(db, row);
      return Boolean(eligible(device, row.source) && digest(device.fcm_token) === row.token_hash);
    },
    complete(scope, input, now) {
      const db = database();
      return db.transaction(() => {
        const key = { ...scope, eventId: input.eventId, installation: input.installationId };
        const row = db.prepare(`SELECT * FROM owner_deliveries WHERE uid=@uid AND project=@project
          AND source=@source AND event_id=@eventId AND installation=@installation`).get(key);
        if (!row || row.status !== 'claimed' || row.claim !== input.claimToken || now >= row.deadline || now < row.deadline - DELIVERY_LEASE_MS) throw new Error('Invalid delivery claim');
        if (input.outcome === 'invalid-registration') {
          const device = currentDevice(db, row);
          if (device?.fcm_token && digest(device.fcm_token) === row.token_hash) {
            db.prepare(`UPDATE owner_devices SET revoked=1, fcm_token=NULL WHERE uid=@uid AND project=@project
              AND installation=@installation`).run({ uid: row.uid, project: row.project, installation: row.installation });
          }
        }
        const retry = input.outcome === 'retryable' && row.attempts < DELIVERY_MAX_ATTEMPTS;
        const delay = Math.max(Math.min(DELIVERY_BACKOFF_CAP_MS, DELIVERY_BACKOFF_MS * 2 ** (row.attempts - 1)), (input.retryAfterSeconds ?? 0) * 1000);
        const status = retry ? 'pending' : input.outcome === 'sent' ? 'sent' : 'terminal';
        const outcome = input.outcome === 'retryable' && !retry ? 'exhausted' : input.outcome;
        db.prepare(`UPDATE owner_deliveries SET status=@status,outcome=@outcome,due=@due,deadline=NULL,claim=NULL
          WHERE uid=@uid AND project=@project AND source=@source AND event_id=@eventId AND installation=@installation`)
          .run({ ...key, status, outcome, due: retry ? now + delay : now });
        return { status, outcome, nextDueAt: retry ? now + delay : null };
      }).immediate();
    },
  };
}
