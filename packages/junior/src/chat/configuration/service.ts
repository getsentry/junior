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
import { toOptionalString } from "@/chat/coerce";
import * as z from "zod";

const legacyNonEmptyStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0);
const legacyOptionalStringSchema = legacyNonEmptyStringSchema
  .optional()
  .catch(undefined);

const legacyEntrySchema = z.object({
  key: legacyNonEmptyStringSchema,
  value: configValueSchema,
  scope: z.enum(["channel", "conversation", "location"]),
  updatedAt: legacyNonEmptyStringSchema,
  updatedBy: legacyOptionalStringSchema,
  source: legacyOptionalStringSchema,
  expiresAt: legacyOptionalStringSchema,
});

// Entries are checked one by one so one invalid entry does not drop the rest.
const legacyLocationConfigSchema = z.object({
  configuration: z.object({
    entries: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]),
  }),
});

function sanitizeEntry(value: unknown): ConfigEntry | undefined {
  const parsed = legacyEntrySchema.safeParse(value);
  if (!parsed.success || validateConfigKey(parsed.data.key)) {
    return undefined;
  }
  return { ...parsed.data, scope: "location" };
}

/** Coerce legacy persisted configuration into current Location entries. */
export function coerceLegacyLocationConfig(raw: unknown): ConfigEntry[] {
  const parsed = legacyLocationConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return [];
  }
  return Object.values(parsed.data.configuration.entries).flatMap((value) => {
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
    const entries = await list(
      options.prefix ? { prefix: options.prefix } : {},
    );
    return Object.fromEntries(
      entries
        .filter((entry) => !keys || keys.includes(entry.key))
        .map((entry) => [entry.key, entry.value]),
    );
  };

  return { get, set, unset, list, resolve, resolveValues };
}
