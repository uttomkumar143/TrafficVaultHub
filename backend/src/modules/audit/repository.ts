/**
 * Audit module — append-only writer over `audit_logs` (migration 0003;
 * PRD §16, §92, §102, §124; ADR-002 §4).
 *
 * Rows are only ever INSERTed. `metadata` must contain non-sensitive values
 * only — callers are responsible for never passing passwords, tokens, hashes
 * or secrets. Returns the D1 statement so callers can include the audit row
 * in the same `db.batch()` as the mutation it describes.
 */
import type { RequestMeta } from "../auth/repository";

export interface AuditEntry {
  organization_id: string | null;
  actor_user_id: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  metadata?: Record<string, unknown>;
  meta: RequestMeta;
}

export interface AuditLogRow {
  id: string;
  organization_id: string | null;
  actor_user_id: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  metadata: string | null;
  request_id: string | null;
  created_at: string;
}

export class AuditRepository {
  constructor(private readonly db: D1Database) {}

  /** Build the INSERT statement without executing it (for batching). */
  statement(entry: AuditEntry): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO audit_logs
           (id, organization_id, actor_user_id, action, target_type, target_id, metadata, ip_address, user_agent, request_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        entry.organization_id,
        entry.actor_user_id,
        entry.action,
        entry.target_type,
        entry.target_id,
        entry.metadata === undefined ? null : JSON.stringify(entry.metadata),
        entry.meta.ip_address,
        entry.meta.user_agent,
        entry.meta.request_id,
      );
  }

  async record(entry: AuditEntry): Promise<void> {
    await this.statement(entry).run();
  }
}
