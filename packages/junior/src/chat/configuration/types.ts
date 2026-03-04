export type ConfigScope = "conversation";

export interface ConfigEntry {
  key: string;
  value: unknown;
  scope: ConfigScope;
  updatedAt: string;
  updatedBy?: string;
  source?: string;
  expiresAt?: string;
}

export interface ChannelConfigState {
  schemaVersion: 1;
  entries: Record<string, ConfigEntry>;
}

export interface ChannelConfigurationStorage {
  load: () => Promise<unknown | null>;
  save: (state: ChannelConfigState) => Promise<void>;
}

export interface ChannelConfigurationService {
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
  resolveValues: (options?: { keys?: string[]; prefix?: string }) => Promise<Record<string, unknown>>;
}
