import { Pool } from 'pg';
import { erpDatabaseService } from './erp-database.service.js';
import { logger } from '../utils/logger.js';
import { config } from '../config/env.js';

export interface AuditLogEntry {
  id?: number;
  sessionId?: string;
  eventType: string; // e.g. 'MESSAGE_RECEIVED', 'AI_REPLY', 'ERP_QUERY', 'SESSION_CONNECTED', 'PDF_PARSED'
  senderJid?: string;
  details?: Record<string, any>;
  ipAddress?: string;
  timestamp?: string;
}

export class AuditLogService {
  private static instance: AuditLogService;
  private inMemoryLogs: AuditLogEntry[] = [];
  private pool: Pool | null = null;
  private tableInitialized = false;

  private constructor() {
    this.pool = erpDatabaseService.getPool();
    if (this.pool) {
      this.initTable().catch((err) => {
        logger.warn({ err: err.message }, 'Failed to init audit_logs table on startup');
      });
    }
  }

  public static getInstance(): AuditLogService {
    if (!AuditLogService.instance) {
      AuditLogService.instance = new AuditLogService();
    }
    return AuditLogService.instance;
  }

  /**
   * Initializes PostgreSQL audit_logs table and standard schema
   */
  public async initTable(): Promise<void> {
    if (this.tableInitialized) return;
    this.pool = erpDatabaseService.getPool();
    if (!this.pool) return;

    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS audit_logs (
          id SERIAL PRIMARY KEY,
          session_id VARCHAR(100),
          event_type VARCHAR(100) NOT NULL,
          sender_jid VARCHAR(150),
          details JSONB DEFAULT '{}'::jsonb,
          ip_address VARCHAR(50),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_audit_event_type ON audit_logs (event_type);
        CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_logs (created_at DESC);
      `);
      this.tableInitialized = true;
      logger.info('Enterprise audit_logs table verified in PostgreSQL.');
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Could not create audit_logs table in PostgreSQL, falling back to memory');
    }
  }

  /**
   * Log an event to PostgreSQL or memory
   */
  public async log(entry: AuditLogEntry): Promise<void> {
    if (!config.AUDIT_LOG_ENABLED) return;

    const record: AuditLogEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
    };

    // Keep last 100 in memory for instant dashboard display
    this.inMemoryLogs.unshift(record);
    if (this.inMemoryLogs.length > 100) {
      this.inMemoryLogs.pop();
    }

    if (this.pool) {
      try {
        await this.pool.query(
          `INSERT INTO audit_logs (session_id, event_type, sender_jid, details, ip_address)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            entry.sessionId || null,
            entry.eventType,
            entry.senderJid || null,
            JSON.stringify(entry.details || {}),
            entry.ipAddress || null,
          ]
        );
      } catch (err: any) {
        logger.error({ err: err.message, eventType: entry.eventType }, 'Failed to insert audit log into PostgreSQL');
      }
    }
  }

  /**
   * Get latest audit logs
   */
  public async getRecentLogs(limit: number = 50): Promise<AuditLogEntry[]> {
    if (this.pool) {
      try {
        const res = await this.pool.query(
          `SELECT id, session_id as "sessionId", event_type as "eventType", sender_jid as "senderJid", details, ip_address as "ipAddress", created_at as "timestamp"
           FROM audit_logs
           ORDER BY created_at DESC
           LIMIT $1`,
          [limit]
        );
        return res.rows;
      } catch (err: any) {
        logger.warn({ err: err.message }, 'Falling back to memory audit logs');
      }
    }
    return this.inMemoryLogs.slice(0, limit);
  }
}

export const auditLogService = AuditLogService.getInstance();
