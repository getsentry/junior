import type {
  ConfigEntry,
  LocationConfigState,
  LocationConfigurationService,
  LocationConfigurationStorage,
} from "@/chat/configuration/types";
import {
  validateConfigKey,
  validateConfigValue,
} from "@/chat/configuration/validation";
import { isRecord, toOptionalString } from "@/chat/coerce";

function sanitizeEntry(value: unknown): ConfigEntry | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const key = toOptionalString(value.key);
  if (!key || validateConfigKey(key)) {
    return undefined;
  }
  const updatedAt = toOptionalString(value.updatedAt);
  if (!updatedAt) {
    return undefined;
  }
  if (
    value.scope !== "channel" &&
    value.scope !== "conversation" &&
    value.scope !== "location"
  ) {
    return undefined;
  }
  return {
    key,
    value: value.value,
    scope: "location",
    updatedAt,
    updatedBy: toOptionalString(value.updatedBy),
    source: toOptionalString(value.source),
    expiresAt: toOptionalString(value.expiresAt),
  };
}

/** Coerce legacy persisted configuration into the current entry shape. */
export function coerceLocationConfigState(raw: unknown): LocationConfigState {
  const rawConfig = isRecord(raw) && isRecord(raw.configuration)
    ? raw.configuration
    : {};
  const rawEntries = isRecord(rawConfig.entries) ? rawConfig.entries : {};
  const entries: Record<string, ConfigEntry> = {};
  for (const value of Object.values(rawEntries)) {
    const entry = sanitizeEntry(value);
    if (entry) {
      entries[entry.key] = entry;
    }
  }
  return { schemaVersion: 1, entries };
}

/** Create a Location configuration service over entry-level storage. */
export function createLocationConfigurationService(
  storage: LocationConfigurationStorage,
): LocationConfigurationService {
  const get = async (key: string): Promise<ConfigEntry | undefined> => {
    const normalizedKey = key.trim();
    return (await storage.list()).find((entry) => entry.key === normalizedKey);
  };

  const set: LocationConfigurationService["set"] = async (input) => {
    const normalizedKey = input.key.trim();
    const keyError = validateConfigKey(normalizedKey);
    if (keyError) {
      throw new Error(keyError);
    }
    const valueError = validateConfigValue(input.value);
    if (valueError) {
      throw new Error(valueError);
    }
    const entry: ConfigEntry = {
      key: normalizedKey,
      value: input.value,
      scope: "location",
      updatedAt: new Date().toISOString(),
      updatedBy: toOptionalString(input.updatedBy),
      source: toOptionalString(input.source),
      expiresAt: toOptionalString(input.expiresAt),
    };
    await storage.set(entry);
    return entry;
  };

  const unset = async (key: string): Promise<boolean> =>
    await storage.unset(key.trim());

  const list = async (
    options: { prefix?: string } = {},
  ): Promise<ConfigEntry[]> => {
    const prefix = options.prefix?.trim();
    return (await storage.list())
      .filter((entry) => (prefix ? entry.key.startsWith(prefix) : true))
      .sort((a, b) => a.key.localeCompare(b.key));
  };

  const resolve = async (key: string): Promise<unknown | undefined> =>
    (await get(key))?.value;

  const resolveValues = async (
    options: { keys?: string[]; prefix?: string } = {},
  ): Promise<Record<string, unknown>> => {
    const keys = options.keys?.map((key) => key.trim()).filter(Boolean);
    const entries = await list(options.prefix ? { prefix: options.prefix } : {});
    return Object.fromEntries(
      entries
        .filter((entry) => !keys || keys.includes(entry.key))
        .map((entry) => [entry.key, entry.value]),
    );
  };

  return { get, set, unset, list, resolve, resolveValues };
}
