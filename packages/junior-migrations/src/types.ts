/** SQL capabilities available to the mixed migration runner. */
export interface MigrationSqlExecutor {
  execute(statement: string, parameters?: readonly unknown[]): Promise<void>;
  query<T = unknown>(
    statement: string,
    parameters?: readonly unknown[],
  ): Promise<T[]>;
  transaction<T>(callback: () => Promise<T>): Promise<T>;
  withMigrationLock<T>(
    migrationTable: string,
    callback: () => Promise<T>,
  ): Promise<T>;
}

/** Stable state-store capabilities exposed to v1 TypeScript migrations. */
export interface MigrationStateV1 {
  appendToList(
    key: string,
    value: unknown,
    options?: { maxLength?: number; ttlMs?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
  get(key: string): Promise<unknown | undefined>;
  getList(key: string): Promise<unknown[]>;
  set(key: string, value: unknown, ttlMs?: number): Promise<void>;
}

/** Resumable progress storage scoped to one TypeScript migration. */
export interface MigrationProgressV1 {
  load(): Promise<MigrationJsonValue | undefined>;
  save(value: MigrationJsonValue): Promise<void>;
}

/** Versioned host tasks available to migrations that predate the public ABI. */
export interface MigrationTasksV1 {
  run(name: string): Promise<MigrationJsonValue | undefined>;
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
  log(message: string): void;
  progress: MigrationProgressV1;
  sql: Pick<MigrationSqlExecutor, "execute" | "query" | "transaction">;
  state: MigrationStateV1;
  tasks: MigrationTasksV1;
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
