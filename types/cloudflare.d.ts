declare global {
  interface D1Result<T = unknown> {
    results: T[];
    success: boolean;
    meta: D1Meta;
    error?: string;
  }
  interface D1Meta {
    duration: number;
    size_after: number;
    rows_read: number;
    rows_written: number;
    last_row_id: number;
    changed_db: boolean;
    changes: number;
    [key: string]: unknown;
  }
  interface D1ExecResult {
    count: number;
    duration: number;
  }
  interface D1DatabaseSession {
    prepare(query: string): D1PreparedStatement;
    batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
    exec(query: string): Promise<D1ExecResult>;
  }
  interface D1PreparedStatement {
    bind(...values: unknown[]): D1PreparedStatement;
    first<T = unknown>(colName?: string): Promise<T | null>;
    run<T = unknown>(): Promise<D1Result<T>>;
    all<T = unknown>(): Promise<D1Result<T>>;
    raw<T = unknown[]>(): Promise<T[]>;
  }
  interface D1Database {
    prepare(query: string): D1PreparedStatement;
    dump(): Promise<ArrayBuffer>;
    batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
    exec(query: string): Promise<D1ExecResult>;
    withSession?(token?: string): D1DatabaseSession;
  }
  interface KVNamespace {
    get(key: string, options?: any): Promise<any>;
    put(key: string, value: any, options?: any): Promise<void>;
    delete(key: string): Promise<void>;
    list(options?: any): Promise<any>;
  }
  interface R2Bucket {
    get(key: string): Promise<any>;
    put(key: string, value: any): Promise<any>;
    delete(key: string | string[]): Promise<void>;
  }
  interface Queue<T = unknown> {
    send(message: T): Promise<void>;
    sendBatch(messages: Iterable<{ body: T }>): Promise<void>;
  }
  interface DurableObjectId {
    toString(): string;
  }
  interface DurableObjectStub {
    fetch(request: Request | string, init?: RequestInit): Promise<Response>;
  }
  interface DurableObjectNamespace {
    idFromName(name: string): DurableObjectId;
    idFromString(id: string): DurableObjectId;
    newUniqueId(): DurableObjectId;
    get(id: DurableObjectId): DurableObjectStub;
  }
  interface DurableObjectState {
    id: DurableObjectId;
    storage: DurableObjectStorage;
    waitUntil(promise: Promise<unknown>): void;
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  }
  interface DurableObjectStorage {
    get<T = unknown>(key: string): Promise<T | undefined>;
    get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
    put<T = unknown>(key: string, value: T): Promise<void>;
    put<T = unknown>(entries: Record<string, T>): Promise<void>;
    delete(key: string): Promise<boolean>;
    delete(keys: string[]): Promise<number>;
    deleteAll(): Promise<void>;
    list<T = unknown>(options?: any): Promise<Map<string, T>>;
    setAlarm(scheduledTime: number | Date): Promise<void>;
    getAlarm(): Promise<number | null>;
    deleteAlarm(): Promise<void>;
  }
}

declare module "cloudflare:workers" {
  export class DurableObject<Env = unknown> {
    ctx: any;
    env: Env;
    constructor(ctx: any, env: Env);
    fetch(request: Request): Promise<Response>;
    alarm?(): Promise<void>;
  }
}

export {};
