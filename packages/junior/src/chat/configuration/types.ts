/** One user-authored configuration value scoped to a Location. */
export interface ConfigEntry {
  key: string;
  value: unknown;
  scope: "location";
  updatedAt: string;
  updatedBy?: string;
  source?: string;
  expiresAt?: string;
}

/** Entry-level persistence used by Location configuration. */
export interface LocationConfigurationStorage {
  get: (key: string) => Promise<ConfigEntry | undefined>;
  list: () => Promise<ConfigEntry[]>;
  set: (entry: ConfigEntry) => Promise<void>;
  unset: (key: string) => Promise<boolean>;
}

/** Read and update user-authored configuration for one Location. */
export interface LocationConfigurationService {
  get: (key: string) => Promise<ConfigEntry | undefined>;
  set: (input: {
    key: string;
    value: unknown;
    updatedBy?: string;
    source?: string;
    expiresAt?: string;
  }) => Promise<ConfigEntry>;
  unset: (key: string) => Promise<boolean>;
  list: (options?: { prefix?: string }) => Promise<ConfigEntry[]>;
  resolve: (key: string) => Promise<unknown | undefined>;
  resolveValues: (options?: {
    keys?: string[];
    prefix?: string;
  }) => Promise<Record<string, unknown>>;
}
