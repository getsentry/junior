export interface PluginDb {
  delete: unknown;
  execute(statement: string, params?: readonly unknown[]): Promise<void>;
  insert: unknown;
  query<T = unknown>(
    statement: string,
    params?: readonly unknown[],
  ): Promise<T[]>;
  select: unknown;
  transaction<T>(callback: (tx: PluginDb) => Promise<T>): Promise<T>;
  update: unknown;
}

export interface PluginDatabaseConfig {
  required?: boolean;
}
