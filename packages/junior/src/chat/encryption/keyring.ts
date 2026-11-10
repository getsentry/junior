/**
 * Encryption keys for secrets that Junior keeps at rest.
 *
 * `JUNIOR_ENCRYPTION_KEYS` lists `<id>:<key>` entries, comma-separated. Each
 * key is 32 random bytes in base64 or base64url. `JUNIOR_ENCRYPTION_KEY_ID`
 * names the key for new values; it is optional when there is one key. All
 * listed keys decrypt. The config fails at startup when a key is invalid, an
 * id repeats, or the active id is not in the list.
 */

const KEY_BYTES = 32;
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;
const KEY_MATERIAL_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/;

/** One AES-256 key and the id that envelopes record. */
interface EncryptionKey {
  id: string;
  key: Buffer;
}

/** The key for new values and every key that can decrypt. */
export interface EncryptionKeyring {
  active: EncryptionKey;
  keys: readonly EncryptionKey[];
}

function parseKey(entry: string, index: number): EncryptionKey {
  const separator = entry.indexOf(":");
  const id = entry.slice(0, separator).trim();
  const material = entry.slice(separator + 1).trim();
  // Errors name the entry, never the key material.
  if (separator < 0 || !KEY_ID_PATTERN.test(id)) {
    throw new Error(
      `JUNIOR_ENCRYPTION_KEYS entry ${index + 1} must be <id>:<key> with an id of letters, digits, ".", "_", or "-"`,
    );
  }
  const key = KEY_MATERIAL_PATTERN.test(material)
    ? Buffer.from(material, "base64")
    : Buffer.alloc(0);
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `JUNIOR_ENCRYPTION_KEYS key "${id}" must be ${KEY_BYTES} bytes in base64`,
    );
  }
  return { id, key };
}

/** Parse and check the encryption keyring from environment variables. */
export function readEncryptionKeyring(
  env: NodeJS.ProcessEnv,
): EncryptionKeyring {
  const entries = (env.JUNIOR_ENCRYPTION_KEYS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    // No default key, not even for local development: each deployment must
    // generate its own.
    throw new Error(
      "JUNIOR_ENCRYPTION_KEYS is required. Generate a key with: " +
        `node -e "console.log('k1:' + require('node:crypto').randomBytes(32).toString('base64url'))"`,
    );
  }
  const keys = entries.map(parseKey);
  const ids = new Set(keys.map((key) => key.id));
  if (ids.size !== keys.length) {
    throw new Error("JUNIOR_ENCRYPTION_KEYS must not repeat a key id");
  }
  const activeId =
    env.JUNIOR_ENCRYPTION_KEY_ID?.trim() ||
    (keys.length === 1 ? keys[0]?.id : undefined);
  if (!activeId) {
    throw new Error(
      "JUNIOR_ENCRYPTION_KEY_ID is required when JUNIOR_ENCRYPTION_KEYS has more than one key",
    );
  }
  const active = keys.find((key) => key.id === activeId);
  if (!active) {
    throw new Error(
      `JUNIOR_ENCRYPTION_KEY_ID "${activeId}" is not in JUNIOR_ENCRYPTION_KEYS`,
    );
  }
  return { active, keys };
}
