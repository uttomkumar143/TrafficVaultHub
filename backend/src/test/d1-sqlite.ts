/**
 * Test-only D1Database shim over `node:sqlite`.
 *
 * Applies the real migration files from `../../migrations` in filename order
 * so tests exercise the actual schema, constraints and SQL that production
 * D1 will run. Implements the subset of the D1 client API used by the app
 * (`prepare().bind().first()/run()/all()`, `batch()`). Not for production.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../migrations");

type Row = Record<string, unknown>;

class TestPreparedStatement {
  private params: unknown[] = [];

  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): TestPreparedStatement {
    const next = new TestPreparedStatement(this.db, this.sql);
    next.params = values.map((v) => (v === undefined ? null : v));
    return next;
  }

  async first<T = Row>(column?: string): Promise<T | null> {
    const stmt = this.db.prepare(this.sql);
    const row = stmt.get(...(this.params as never[])) as Row | undefined;
    if (!row) return null;
    if (column !== undefined) return (row[column] as T) ?? null;
    return row as T;
  }

  async run<T = Row>(): Promise<D1Result<T>> {
    const stmt = this.db.prepare(this.sql);
    const isRead = /^\s*(select|pragma|with)\b/i.test(this.sql);
    if (isRead) {
      const rows = stmt.all(...(this.params as never[])) as T[];
      return {
        success: true,
        results: rows,
        meta: this.meta(rows.length, 0, null) as D1Result<T>["meta"],
      };
    }
    const info = stmt.run(...(this.params as never[]));
    return {
      success: true,
      results: [] as T[],
      meta: this.meta(0, Number(info.changes), info.lastInsertRowid) as D1Result<T>["meta"],
    };
  }

  async all<T = Row>(): Promise<D1Result<T>> {
    return this.run<T>();
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const stmt = this.db.prepare(this.sql);
    const rows = stmt.all(...(this.params as never[])) as Row[];
    return rows.map((r) => Object.values(r) as unknown as T);
  }

  private meta(read: number, changes: number, lastRowId: number | bigint | null): D1Meta {
    return {
      duration: 0,
      size_after: 0,
      rows_read: read,
      rows_written: changes,
      last_row_id: lastRowId === null ? 0 : Number(lastRowId),
      changed_db: changes > 0,
      changes,
    };
  }
}

export interface TestD1 extends D1Database {
  /** Direct handle for assertions / fixture setup in tests. */
  readonly sqlite: DatabaseSync;
  close(): void;
}

export function createTestD1(): TestD1 {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f: string) => f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }

  const shim = {
    sqlite,
    close: () => sqlite.close(),
    prepare(sql: string) {
      return new TestPreparedStatement(sqlite, sql) as unknown as D1PreparedStatement;
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const out: D1Result<T>[] = [];
      sqlite.exec("BEGIN");
      try {
        for (const s of statements) out.push(await s.run<T>());
        sqlite.exec("COMMIT");
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
      return out;
    },
    async exec(sql: string): Promise<D1ExecResult> {
      sqlite.exec(sql);
      return { count: 1, duration: 0 };
    },
    dump(): Promise<ArrayBuffer> {
      return Promise.reject(new Error("dump() not supported in test shim"));
    },
    withSession(): D1DatabaseSession {
      throw new Error("withSession() not supported in test shim");
    },
  };

  return shim as unknown as TestD1;
}
