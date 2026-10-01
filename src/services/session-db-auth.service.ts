import { AuthenticationCreds, AuthenticationState, SignalDataTypeMap, initAuthCreds, proto } from '@whiskeysockets/baileys';
import { Pool } from 'pg';
import { erpDatabaseService } from './erp-database.service.js';
import { logger } from '../utils/logger.js';

/**
 * Custom PostgreSQL Baileys AuthenticationState adapter.
 * Serializes WhatsApp cryptographic credentials and pre-keys directly into PostgreSQL table `whatsapp_sessions`.
 * This prevents session loss when Render containers spin down or restart!
 */
export async function usePostgresAuthState(sessionId: string): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  const pool: Pool | null = erpDatabaseService.getPool();

  if (!pool) {
    throw new Error('PostgreSQL Pool is not available for usePostgresAuthState');
  }

  // Ensure table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_sessions (
      session_id VARCHAR(100) NOT NULL,
      key_id VARCHAR(255) NOT NULL,
      data JSONB NOT NULL,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (session_id, key_id)
    );
    CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_id ON whatsapp_sessions (session_id);
  `);

  // Buffer serialization helper
  const replacer = (_: any, value: any) => {
    if (value && typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)) {
      return { _isBuffer: true, data: Buffer.from(value.data).toString('base64') };
    }
    if (Buffer.isBuffer(value)) {
      return { _isBuffer: true, data: value.toString('base64') };
    }
    if (value instanceof Uint8Array) {
      return { _isBuffer: true, data: Buffer.from(value).toString('base64') };
    }
    return value;
  };

  const reviver = (_: any, value: any) => {
    if (value && typeof value === 'object' && value._isBuffer && typeof value.data === 'string') {
      return Buffer.from(value.data, 'base64');
    }
    return value;
  };

  // Helper to read data from DB
  const readData = async (keyId: string): Promise<any> => {
    try {
      const res = await pool.query(
        'SELECT data FROM whatsapp_sessions WHERE session_id = $1 AND key_id = $2',
        [sessionId, keyId]
      );
      if (res.rows.length > 0) {
        const rawJson = typeof res.rows[0].data === 'string' ? res.rows[0].data : JSON.stringify(res.rows[0].data);
        return JSON.parse(rawJson, reviver);
      }
      return null;
    } catch (err: any) {
      logger.error({ sessionId, keyId, err: err.message }, 'Failed to read key from postgres whatsapp_sessions');
      return null;
    }
  };

  // Helper to write data to DB
  const writeData = async (keyId: string, data: any): Promise<void> => {
    try {
      const serialized = JSON.stringify(data, replacer);
      await pool.query(
        `INSERT INTO whatsapp_sessions (session_id, key_id, data, updated_at)
         VALUES ($1, $2, $3::jsonb, CURRENT_TIMESTAMP)
         ON CONFLICT (session_id, key_id)
         DO UPDATE SET data = EXCLUDED.data, updated_at = CURRENT_TIMESTAMP`,
        [sessionId, keyId, serialized]
      );
    } catch (err: any) {
      logger.error({ sessionId, keyId, err: err.message }, 'Failed to write key to postgres whatsapp_sessions');
    }
  };

  // Helper to remove data from DB
  const removeData = async (keyId: string): Promise<void> => {
    try {
      await pool.query(
        'DELETE FROM whatsapp_sessions WHERE session_id = $1 AND key_id = $2',
        [sessionId, keyId]
      );
    } catch (err: any) {
      logger.error({ sessionId, keyId, err: err.message }, 'Failed to delete key from postgres whatsapp_sessions');
    }
  };

  const credsData = await readData('creds');
  const creds: AuthenticationCreds = credsData || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type: keyof SignalDataTypeMap, ids: string[]) => {
          const result: Record<string, any> = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              if (value) {
                result[id] = value;
              }
            })
          );
          return result;
        },
        set: async (data: any) => {
          const tasks: Promise<void>[] = [];
          for (const category of Object.keys(data)) {
            const cat = category as keyof SignalDataTypeMap;
            for (const id of Object.keys(data[cat])) {
              const value = data[cat][id];
              const key = `${cat}-${id}`;
              if (value) {
                tasks.push(writeData(key, value));
              } else {
                tasks.push(removeData(key));
              }
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData('creds', creds),
  };
}

/**
 * Remove all keys for a session in PostgreSQL
 */
export async function clearPostgresSession(sessionId: string): Promise<void> {
  const pool = erpDatabaseService.getPool();
  if (pool) {
    try {
      await pool.query('DELETE FROM whatsapp_sessions WHERE session_id = $1', [sessionId]);
      logger.info(`PostgreSQL session cleared for ${sessionId}`);
    } catch (err: any) {
      logger.error({ sessionId, err: err.message }, 'Failed to clear session in postgres');
    }
  }
}

/**
 * List all sessions stored in PostgreSQL
 */
export async function listPostgresSessions(): Promise<string[]> {
  const pool = erpDatabaseService.getPool();
  if (!pool) return [];
  try {
    const res = await pool.query(
      "SELECT DISTINCT session_id FROM whatsapp_sessions WHERE key_id = 'creds'"
    );
    return res.rows.map((r) => r.session_id);
  } catch (err: any) {
    logger.warn({ err: err.message }, 'Could not list postgres sessions');
    return [];
  }
}
