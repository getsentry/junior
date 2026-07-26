/** Database capabilities exposed to v1 TypeScript migrations. */
export interface MigrationDatabaseAdapter {
  db(): unknown;
  execute(statement: string, parameters?: readonly unknown[]): Promise<void>;
  query<T = unknown>(
    statement: string,
    parameters?: readonly unknown[],
  ): Promise<T[]>;
  transaction<T>(callback: () => Promise<T>): Promise<T>;
  withLock<T>(lockName: string, callback: () => Promise<T>): Promise<T>;
}

/** Host executor used to serialize and persist one migration journal. */
export interface MigrationJournalExecutor extends MigrationDatabaseAdapter {
  withMigrationLock<T>(
    migrationTable: string,
    callback: () => Promise<T>,
  ): Promise<T>;
}

/** Stable state-store capabilities exposed to v1 TypeScript migrations. */
export interface MigrationLockV1 {
  expiresAt: number;
  threadId: string;
  token: string;
}

/** Stable state-store capabilities exposed to v1 TypeScript migrations. */
export interface MigrationStateV1 {
  acquireLock(threadId: string, ttlMs: number): Promise<MigrationLockV1 | null>;
  appendToList(
    key: string,
    value: unknown,
    options?: { maxLength?: number; ttlMs?: number },
  ): Promise<void>;
  connect(): Promise<void>;
  delete(key: string): Promise<void>;
  get<T = unknown>(key: string): Promise<T | null | undefined>;
  getList<T = unknown>(key: string): Promise<T[]>;
  releaseLock(lock: MigrationLockV1): Promise<void>;
  set(key: string, value: unknown, ttlMs?: number): Promise<void>;
  setIfNotExists(key: string, value: unknown, ttlMs?: number): Promise<boolean>;
}

/** Optional raw Redis capability for migrations preserving Redis indexes. */
export interface MigrationRedisV1 {
  sendCommand<T = unknown>(args: readonly string[]): Promise<T>;
}

/** Resumable progress storage scoped to one TypeScript migration. */
export interface MigrationProgressV1 {
  load(): Promise<MigrationJsonValue | undefined>;
  save(value: MigrationJsonValue): Promise<void>;
}

/** JSON-compatible value persisted in migration progress and result columns. */
export type MigrationJsonValue =
  | boolean
  | number
  | string
  | null
  | MigrationJsonValue[]
  | { [key: string]: MigrationJsonValue };

/** Permanent capability contract for apiVersion 1 migrations. */
export interface MigrationContextV1 {
  database: MigrationDatabaseAdapter;
  log(message: string): void;
  progress: MigrationProgressV1;
  redis?: MigrationRedisV1;
  state: MigrationStateV1;
}

/** Isolated TypeScript data migration targeting the v1 ABI. */
export interface MigrationV1 {
  apiVersion: 1;
  up(context: MigrationContextV1): Promise<MigrationJsonValue | undefined>;
}

/** One ordered entry from Drizzle Kit's journal metadata. */
export interface MigrationJournalEntry {
  breakpoints: boolean;
  index: number;
  tag: string;
  when: number;
}

/** Journal entry paired with its unique SQL or TypeScript source file. */
export interface ResolvedMigration extends MigrationJournalEntry {
  hash: string;
  kind: "sql" | "typescript";
  path: string;
  source: string;
}

/** Aggregate counts returned after one journal execution. */
export interface MigrationRunResult {
  existing: number;
  migrated: number;
  scanned: number;
  skipped: number;
}

/** Host-provided loader for an isolated TypeScript migration module. */
export interface TypeScriptMigrationLoader {
  (path: string): Promise<unknown>;
}
