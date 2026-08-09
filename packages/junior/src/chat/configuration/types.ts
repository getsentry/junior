export type ConfigScope = "destination";

export interface ConfigEntry {
  key: string;
  value: unknown;
  scope: ConfigScope;
  updatedAt: string;
  updatedBy?: string;
  source?: string;
  expiresAt?: string;
}

export interface DestinationConfigState {
  schemaVersion: 1;
  entries: Record<string, ConfigEntry>;
}

export interface DestinationConfigurationStorage {
  load: () => Promise<unknown | null>;
  save: (state: DestinationConfigState) => Promise<void>;
}

export interface DestinationConfigurationService {
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
