import { getConnection } from '../connection.js';

// Schema is initialized only on repository use, never on module import.
export function createOwnerSessionRepository(connection = getConnection) {
  const database = () => {
    const db = connection();
    db.exec(`
      CREATE TABLE IF NOT EXISTS owner_exchange_codes (
        hash TEXT PRIMARY KEY, uid TEXT NOT NULL, project TEXT NOT NULL,
        installation TEXT NOT NULL, service TEXT NOT NULL,
        expires INTEGER NOT NULL, session_expires INTEGER NOT NULL,
        consumed INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS owner_sessions (
        hash TEXT PRIMARY KEY, uid TEXT NOT NULL, project TEXT NOT NULL,
        installation TEXT NOT NULL, service TEXT NOT NULL,
        expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
      );
    `);
    return db;
  };
  return {
    insertCode(record) {
      database().prepare(`INSERT INTO owner_exchange_codes
        (hash, uid, project, installation, service, expires, session_expires)
        VALUES (@hash, @uid, @project, @installation, @service, @expires, @sessionExpires)`).run(record);
    },
    consumeCode(binding, sessionHash, now) {
      const db = database();
      return db.transaction(() => {
        const code = db.prepare(`UPDATE owner_exchange_codes SET consumed = 1
          WHERE hash = @hash AND uid = @uid AND project = @project
          AND installation = @installation AND service = @service
          AND consumed = 0 AND revoked = 0 AND expires > @now AND session_expires > @now
          RETURNING session_expires AS expires`).get({ ...binding, now });
        if (!code) return null;
        db.prepare(`INSERT INTO owner_sessions (hash, uid, project, installation, service, expires)
          VALUES (@hash, @uid, @project, @installation, @service, @expires)`)
          .run({ ...binding, hash: sessionHash, expires: code.expires });
        return { expiresAt: code.expires };
      }).immediate();
    },
    authenticate(binding, now) {
      const row = database().prepare(`SELECT expires FROM owner_sessions
        WHERE hash = @hash AND uid = @uid AND project = @project
        AND installation = @installation AND service = @service
        AND revoked = 0 AND expires > @now`).get({ ...binding, now });
      return row ? { expiresAt: row.expires } : null;
    },
    revokeSession(binding, now) {
      return database().prepare(`UPDATE owner_sessions SET revoked = 1
        WHERE hash = @hash AND uid = @uid AND project = @project
        AND installation = @installation AND service = @service
        AND revoked = 0 AND expires > @now`).run({ ...binding, now }).changes === 1;
    },
    revokeInstallation(binding, now) {
      const db = database();
      return db.transaction(() => {
        if (!this.authenticate(binding, now)) return false;
        const scope = { uid: binding.uid, project: binding.project, installation: binding.installation, service: binding.service };
        for (const table of ['owner_sessions', 'owner_exchange_codes']) {
          db.prepare(`UPDATE ${table} SET revoked = 1 WHERE uid = @uid AND project = @project
            AND installation = @installation AND service = @service`).run(scope);
        }
        return true;
      }).immediate();
    },
  };
}
