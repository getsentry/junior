// The encryption group: keys for secrets at rest.
import * as z from "zod";
import type { Env } from "@/config/fields";

const ENCRYPTION_KEY_BYTES = 32;
const ENCRYPTION_KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;
const ENCRYPTION_KEY_MATERIAL_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/;
/** How to generate a key, for the missing-keys error. */
export const ENCRYPTION_KEYS_HINT =
  "Generate a key with: " +
  `node -e "console.log('k1:' + require('node:crypto').randomBytes(32).toString('base64url'))"`;

// A key is 32 random bytes in base64 or base64url.
function isEncryptionKeyMaterial(material: string): boolean {
  return (
    ENCRYPTION_KEY_MATERIAL_PATTERN.test(material) &&
    Buffer.from(material, "base64").length === ENCRYPTION_KEY_BYTES
  );
}

/**
 * Keys for secrets at rest, as plain data. `createEncryptionKeyring` builds
 * the keyring. Startup fails when they are missing or invalid.
 */
export const encryptionSchema = z
  .strictObject({
    /** Key for new values. */
    activeKeyId: z.string(),
    /** Every key that decrypts, as base64 key material. */
    keys: z
      .array(
        z.strictObject({
          id: z.string().regex(ENCRYPTION_KEY_ID_PATTERN),
          key: z
            .string()
            .refine(
              isEncryptionKeyMaterial,
              `must be ${ENCRYPTION_KEY_BYTES} bytes in base64`,
            ),
        }),
      )
      .min(1),
  })
  .refine(
    ({ keys }) => new Set(keys.map(({ id }) => id)).size === keys.length,
    { message: "must not repeat a key id", path: ["keys"] },
  )
  .refine(
    ({ activeKeyId, keys }) => keys.some(({ id }) => id === activeKeyId),
    {
      message: "must name a listed key",
      path: ["activeKeyId"],
    },
  );

/** Env var that sets each encryption field, for error messages. */
export const encryptionEnvNames: Record<string, string> = {
  encryption: "JUNIOR_ENCRYPTION_KEYS",
  "encryption.activeKeyId": "JUNIOR_ENCRYPTION_KEY_ID",
};

function parseEncryptionKey(entry: string, index: number) {
  const separator = entry.indexOf(":");
  const id = entry.slice(0, separator).trim();
  const key = entry.slice(separator + 1).trim();
  // Errors name the entry, never the key material.
  if (separator < 0 || !ENCRYPTION_KEY_ID_PATTERN.test(id)) {
    throw new Error(
      `JUNIOR_ENCRYPTION_KEYS entry ${index + 1} must be <id>:<key> with an id of letters, digits, ".", "_", or "-"`,
    );
  }
  if (!isEncryptionKeyMaterial(key)) {
    throw new Error(
      `JUNIOR_ENCRYPTION_KEYS key "${id}" must be ${ENCRYPTION_KEY_BYTES} bytes in base64`,
    );
  }
  return { id, key };
}

/**
 * `JUNIOR_ENCRYPTION_KEYS` lists `<id>:<key>` entries, comma-separated.
 * `JUNIOR_ENCRYPTION_KEY_ID` names the key for new values; it is optional
 * when there is one key. All listed keys decrypt.
 */
export function readEncryption(
  env: Env,
): z.input<typeof encryptionSchema> | undefined {
  const entries = (env["JUNIOR_ENCRYPTION_KEYS"] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  // No default key, not even for local development: each deployment must
  // generate its own. The schema reports the missing keys.
  if (entries.length === 0) {
    return undefined;
  }
  const keys = entries.map(parseEncryptionKey);
  if (new Set(keys.map(({ id }) => id)).size !== keys.length) {
    throw new Error("JUNIOR_ENCRYPTION_KEYS must not repeat a key id");
  }
  const activeKeyId =
    env["JUNIOR_ENCRYPTION_KEY_ID"]?.trim() ||
    (keys.length === 1 ? keys[0]?.id : undefined);
  if (!activeKeyId) {
    throw new Error(
      "JUNIOR_ENCRYPTION_KEY_ID is required when JUNIOR_ENCRYPTION_KEYS has more than one key",
    );
  }
  if (!keys.some(({ id }) => id === activeKeyId)) {
    throw new Error(
      `JUNIOR_ENCRYPTION_KEY_ID "${activeKeyId}" is not in JUNIOR_ENCRYPTION_KEYS`,
    );
  }
  return { activeKeyId, keys };
}
