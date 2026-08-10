import { configValueSchema } from "@/chat/configuration/types";
import type {
  ConfigEntry,
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
  const parsedValue = configValueSchema.safeParse(value.value);
  if (!parsedValue.success) {
    return undefined;
  }
  return {
    key,
    value: parsedValue.data,
    scope: "location",
    updatedAt,
    updatedBy: toOptionalString(value.updatedBy),
    source: toOptionalString(value.source),
    expiresAt: toOptionalString(value.expiresAt),
  };
}

/** Coerce legacy persisted configuration into current Location entries. */
export function coerceLegacyLocationConfig(raw: unknown): ConfigEntry[] {
  const rawConfig = isRecord(raw) && isRecord(raw.configuration)
    ? raw.configuration
    : {};
  const rawEntries = isRecord(rawConfig.entries) ? rawConfig.entries : {};
  return Object.values(rawEntries).flatMap((value) => {
    const entry = sanitizeEntry(value);
    return entry ? [entry] : [];
  });
}

/** Create a Location configuration service over entry-level storage. */
export function createLocationConfigurationService(
  storage: LocationConfigurationStorage,
): LocationConfigurationService {
  const get = async (key: string): Promise<ConfigEntry | undefined> =>
    await storage.get(key.trim());

  const set: LocationConfigurationService["set"] = async (input) => {
    const normalizedKey = input.key.trim();
    const keyError = validateConfigKey(normalizedKey);
    if (keyError) {
      throw new Error(keyError);
    }
    const value = configValueSchema.parse(input.value);
    const valueError = validateConfigValue(value);
    if (valueError) {
      throw new Error(valueError);
    }
    const entry: ConfigEntry = {
      key: normalizedKey,
      value,
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

  const resolve: LocationConfigurationService["resolve"] = async (key) =>
    (await get(key))?.value;

  const resolveValues = async (
    options: { keys?: string[]; prefix?: string } = {},
  ): ReturnType<LocationConfigurationService["resolveValues"]> => {
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
