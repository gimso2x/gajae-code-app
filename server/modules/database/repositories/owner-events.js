import { getConnection } from '../connection.js';

export function createOwnerEventRepository(connection = getConnection) {
  const database = () => {
    const db = connection();
    db.exec(`CREATE TABLE IF NOT EXISTS owner_events (
      uid TEXT NOT NULL, project TEXT NOT NULL, source TEXT NOT NULL,
      event_id TEXT NOT NULL, deduplication_key TEXT NOT NULL, envelope TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      PRIMARY KEY (uid, project, source, event_id),
      UNIQUE (uid, project, source, deduplication_key)
    )`);
    return db;
  };
  return {
    insert(scope, event) {
      const db = database();
      const envelope = JSON.stringify(event);
      return db.transaction(() => {
        const rows = db.prepare(`SELECT envelope FROM owner_events
          WHERE uid = @uid AND project = @project AND source = @source
          AND (event_id = @eventId OR deduplication_key = @deduplicationKey)`)
          .all({ ...scope, eventId: event.eventId, deduplicationKey: event.deduplicationKey });
        if (rows.length) return rows.length === 1 && rows[0].envelope === envelope ? 'duplicate' : 'conflict';
        db.prepare(`INSERT INTO owner_events (uid, project, source, event_id, deduplication_key, envelope)
          VALUES (@uid, @project, @source, @eventId, @deduplicationKey, @envelope)`)
          .run({ ...scope, eventId: event.eventId, deduplicationKey: event.deduplicationKey, envelope });
        return 'inserted';
      }).immediate();
    },
    pending(scope, limit) {
      return database().prepare(`SELECT envelope FROM owner_events
        WHERE uid = @uid AND project = @project AND source = @source AND status = 'pending'
        ORDER BY rowid LIMIT @limit`).all({ ...scope, limit }).map((row) => JSON.parse(row.envelope));
    },
  };
}
