import { getConnection } from '../connection.js';

export function createOwnerDeviceRepository(connection = getConnection) {
  const database = () => {
    const db = connection();
    db.exec(`CREATE TABLE IF NOT EXISTS owner_devices (
      uid TEXT NOT NULL, project TEXT NOT NULL, installation TEXT NOT NULL,
      platform TEXT NOT NULL, fcm_token TEXT, settings TEXT NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (uid, project, installation)
    )`);
    return db;
  };
  const publicRecord = (row) => row ? {
    installationId: row.installation, platform: row.platform,
    enabled: JSON.parse(row.settings), revoked: Boolean(row.revoked),
  } : null;
  const select = (db, scope) => db.prepare(`SELECT installation, platform, settings, revoked FROM owner_devices
    WHERE uid = @uid AND project = @project AND installation = @installation`).get(scope);
  return {
    upsert(scope, fcmToken, enabled) {
      const db = database();
      return db.transaction(() => {
        const current = select(db, scope);
        const settings = { gjc: false, board: false, proxy: false, ...(current ? JSON.parse(current.settings) : {}), ...enabled };
        db.prepare(`INSERT INTO owner_devices (uid, project, installation, platform, fcm_token, settings)
          VALUES (@uid, @project, @installation, 'android', @token, @settings)
          ON CONFLICT(uid, project, installation) DO UPDATE SET
          fcm_token = excluded.fcm_token, settings = excluded.settings, revoked = 0`)
          .run({ ...scope, token: fcmToken, settings: JSON.stringify(settings) });
        return publicRecord(select(db, scope));
      }).immediate();
    },
    get(scope) { const db = database(); return publicRecord(select(db, scope)); },
    patch(scope, enabled) {
      const db = database();
      return db.transaction(() => {
        const current = select(db, scope);
        if (!current || current.revoked) return null;
        db.prepare(`UPDATE owner_devices SET settings = @settings
          WHERE uid = @uid AND project = @project AND installation = @installation`)
          .run({ ...scope, settings: JSON.stringify({ ...JSON.parse(current.settings), ...enabled }) });
        return publicRecord(select(db, scope));
      }).immediate();
    },
    revoke(scope) {
      const db = database();
      return db.transaction(() => {
        db.prepare(`UPDATE owner_devices SET revoked = 1, fcm_token = NULL
          WHERE uid = @uid AND project = @project AND installation = @installation`).run(scope);
        return publicRecord(select(db, scope));
      }).immediate();
    },
  };
}
