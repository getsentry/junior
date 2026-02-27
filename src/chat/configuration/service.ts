import type {
  ChannelConfigState,
  ChannelConfigurationService,
  ChannelConfigurationStorage,
  ConfigEntry
} from "@/chat/configuration/types";
import { validateConfigKey, validateConfigValue } from "@/chat/configuration/validation";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function defaultState(): ChannelConfigState {
  return {
    schemaVersion: 1,
    entries: {}
  };
}

function sanitizeEntry(value: unknown): ConfigEntry | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const key = toOptionalString(value.key);
  if (!key) {
    return undefined;
  }
  if (validateConfigKey(key)) {
    return undefined;
  }

  const updatedAt = toOptionalString(value.updatedAt);
  if (!updatedAt) {
    return undefined;
  }
  const scope = value.scope === "channel" ? "channel" : undefined;
  if (!scope) {
    return undefined;
  }

  return {
    key,
    value: value.value,
    scope,
    updatedAt,
    updatedBy: toOptionalString(value.updatedBy),
    source: toOptionalString(value.source),
    expiresAt: toOptionalString(value.expiresAt)
  };
}

function coerceState(raw: unknown): ChannelConfigState {
  if (!isRecord(raw)) {
    return defaultState();
  }

  const rawConfig = isRecord(raw.configuration) ? raw.configuration : {};
  const rawEntries = isRecord(rawConfig.entries) ? rawConfig.entries : {};
  const entries: Record<string, ConfigEntry> = {};
  for (const [key, value] of Object.entries(rawEntries)) {
    const entry = sanitizeEntry(value);
    if (!entry) {
      continue;
    }
    entries[key] = entry;
  }

  return {
    schemaVersion: 1,
    entries
  };
}

export function createChannelConfigurationService(storage: ChannelConfigurationStorage): ChannelConfigurationService {
  const getState = async (): Promise<ChannelConfigState> => {
    const loaded = await storage.load();
    return coerceState(loaded);
  };

  const saveState = async (state: ChannelConfigState): Promise<void> => {
    await storage.save({
      schemaVersion: 1,
      entries: state.entries
    });
  };

  const get = async (key: string): Promise<ConfigEntry | undefined> => {
    const normalizedKey = key.trim();
    const state = await getState();
    return state.entries[normalizedKey];
  };

  const set: ChannelConfigurationService["set"] = async (input) => {
    const normalizedKey = input.key.trim();
    const keyError = validateConfigKey(normalizedKey);
    if (keyError) {
      throw new Error(keyError);
    }

    const valueError = validateConfigValue(input.value);
    if (valueError) {
      throw new Error(valueError);
    }

    const state = await getState();
    const nextEntry: ConfigEntry = {
      key: normalizedKey,
      value: input.value,
      scope: "channel",
      updatedAt: new Date().toISOString(),
      updatedBy: toOptionalString(input.updatedBy),
      source: toOptionalString(input.source),
      expiresAt: toOptionalString(input.expiresAt)
    };
    state.entries[normalizedKey] = nextEntry;
    await saveState(state);
    return nextEntry;
  };

  const unset = async (key: string): Promise<boolean> => {
    const normalizedKey = key.trim();
    const state = await getState();
    if (!state.entries[normalizedKey]) {
      return false;
    }
    delete state.entries[normalizedKey];
    await saveState(state);
    return true;
  };

  const list = async (options: { prefix?: string } = {}): Promise<ConfigEntry[]> => {
    const state = await getState();
    const prefix = options.prefix?.trim();
    return Object.values(state.entries)
      .filter((entry) => (prefix ? entry.key.startsWith(prefix) : true))
      .sort((a, b) => a.key.localeCompare(b.key));
  };

  const resolve = async (key: string): Promise<unknown | undefined> => {
    const entry = await get(key);
    return entry?.value;
  };

  const resolveValues = async (options: { keys?: string[]; prefix?: string } = {}): Promise<Record<string, unknown>> => {
    const keys = Array.isArray(options.keys)
      ? options.keys.map((entry) => entry.trim()).filter((entry) => entry.length > 0)
      : undefined;
    const entries = await list({
      ...(options.prefix ? { prefix: options.prefix } : {})
    });

    const filtered = keys ? entries.filter((entry) => keys.includes(entry.key)) : entries;
    const resolved: Record<string, unknown> = {};
    for (const entry of filtered) {
      resolved[entry.key] = entry.value;
    }
    return resolved;
  };

  return {
    get,
    set,
    unset,
    list,
    resolve,
    resolveValues
  };
}
