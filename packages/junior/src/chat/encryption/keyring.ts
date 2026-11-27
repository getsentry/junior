import type { EncryptionConfig } from "@/config";

/**
 * Encryption keys for secrets that Junior keeps at rest. `src/config/`
 * reads and checks them from `JUNIOR_ENCRYPTION_KEYS` and
 * `JUNIOR_ENCRYPTION_KEY_ID`.
 */

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

/** Build the keyring from checked encryption config. */
export function createEncryptionKeyring(
  config: EncryptionConfig,
): EncryptionKeyring {
  const keys = config.keys.map(({ id, key }) => ({
    id,
    key: Buffer.from(key, "base64"),
  }));
  const active = keys.find((key) => key.id === config.activeKeyId);
  if (!active) {
    throw new Error(
      `Active encryption key "${config.activeKeyId}" is not in the keyring`,
    );
  }
  return { active, keys };
}
