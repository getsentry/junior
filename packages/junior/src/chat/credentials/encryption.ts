/**
 * Encryption at rest for stored provider credentials.
 *
 * Stored OAuth tokens use AES-256-GCM with a key ring from the environment:
 *
 * - `JUNIOR_ENCRYPTION_KEYS` lists every key Junior can decrypt with, as
 *   comma-separated `<key id>:<base64 32-byte key>` entries.
 * - `JUNIOR_ENCRYPTION_KEY_ID` names the key that encrypts new values. When it
 *   is not set, Junior can still decrypt but writes plain text. This lets every
 *   deployment load a new key before any deployment writes with it.
 *
 * Each value is bound to its record key as associated data, so a value copied
 * into another record does not decrypt. Temporary sign-in state is out of
 * scope; only long-lived stored credentials use this module.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VALUE_PREFIX = "jenc:v1:";
const ASSOCIATED_DATA_CONTEXT = "junior.stored-credential.v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/** Parsed credential encryption keys and the key that encrypts new values. */
export interface CredentialKeyRing {
  activeKeyId?: string;
  keys: Map<string, Buffer>;
}

/** A stored credential is encrypted but Junior cannot decrypt it. */
export class CredentialDecryptionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CredentialDecryptionError";
  }
}

function parseKeyEntry(entry: string, index: number): [string, Buffer] {
  const separator = entry.indexOf(":");
  const keyId = separator === -1 ? "" : entry.slice(0, separator).trim();
  const encodedKey = separator === -1 ? "" : entry.slice(separator + 1).trim();
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new Error(
      `JUNIOR_ENCRYPTION_KEYS entry ${index + 1} must look like <key id>:<base64 key>, with a key id of 1-32 letters, digits, "_", or "-"`,
    );
  }
  const key = BASE64_PATTERN.test(encodedKey)
    ? Buffer.from(encodedKey, "base64")
    : undefined;
  if (key?.length !== KEY_BYTES) {
    throw new Error(
      `JUNIOR_ENCRYPTION_KEYS key "${keyId}" must be ${KEY_BYTES} bytes encoded as base64`,
    );
  }
  return [keyId, key];
}

/**
 * Read the credential key ring from the environment.
 *
 * Returns `undefined` when encryption is not configured. A configuration that
 * is present but invalid throws, so a typo cannot silently turn encryption off.
 */
export function readCredentialKeyRing(
  env: NodeJS.ProcessEnv = process.env,
): CredentialKeyRing | undefined {
  const rawKeys = env.JUNIOR_ENCRYPTION_KEYS?.trim();
  const activeKeyId = env.JUNIOR_ENCRYPTION_KEY_ID?.trim() || undefined;
  // Encryption is optional for now so existing apps keep working without new
  // configuration. We expect to require JUNIOR_ENCRYPTION_KEYS in a later
  // release.
  if (!rawKeys) {
    if (activeKeyId) {
      throw new Error(
        "JUNIOR_ENCRYPTION_KEY_ID is set, but JUNIOR_ENCRYPTION_KEYS is empty",
      );
    }
    return undefined;
  }

  const keys = new Map<string, Buffer>();
  rawKeys
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .forEach((entry, index) => {
      const [keyId, key] = parseKeyEntry(entry, index);
      if (keys.has(keyId)) {
        throw new Error(
          `JUNIOR_ENCRYPTION_KEYS contains key id "${keyId}" more than once`,
        );
      }
      keys.set(keyId, key);
    });
  if (activeKeyId && !keys.has(activeKeyId)) {
    throw new Error(
      `JUNIOR_ENCRYPTION_KEY_ID "${activeKeyId}" is not in JUNIOR_ENCRYPTION_KEYS`,
    );
  }
  return { activeKeyId, keys };
}

function associatedData(recordKey: string): Buffer {
  return Buffer.from(`${ASSOCIATED_DATA_CONTEXT}\0${recordKey}`, "utf8");
}

function isEncrypted(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(VALUE_PREFIX);
}

/** Return the key id of an encrypted stored value, or `undefined` for plain text. */
export function storedCredentialKeyId(value: unknown): string | undefined {
  return isEncrypted(value)
    ? value.slice(VALUE_PREFIX.length).split(":")[0]
    : undefined;
}

/**
 * Return the value to store for one credential.
 *
 * `value` is what the store would otherwise pass to `StateAdapter.set`. With
 * an active key, the result is one encrypted string that holds its JSON.
 * Without an active key, the result is `value` unchanged.
 */
export function encryptStoredCredential(
  value: unknown,
  recordKey: string,
  keyRing: CredentialKeyRing | undefined = readCredentialKeyRing(),
): unknown {
  const keyId = keyRing?.activeKeyId;
  const key = keyId ? keyRing.keys.get(keyId) : undefined;
  if (!keyId || !key) {
    return value;
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(associatedData(recordKey));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return `${VALUE_PREFIX}${keyId}:${iv.toString("base64url")}:${ciphertext.toString("base64url")}`;
}

/**
 * Return the original value of one stored credential.
 *
 * Plain-text values return unchanged. Throws `CredentialDecryptionError` when
 * the key is not configured or the value does not decrypt for this record.
 * Callers must not treat that as a missing credential: another deployment may
 * still have the key.
 */
export function decryptStoredCredential(
  stored: unknown,
  recordKey: string,
  keyRing: CredentialKeyRing | undefined = readCredentialKeyRing(),
): unknown {
  if (!isEncrypted(stored)) {
    return stored;
  }
  const [keyId, encodedIv, encodedCiphertext, extra] = stored
    .slice(VALUE_PREFIX.length)
    .split(":");
  if (!keyId || !encodedIv || !encodedCiphertext || extra !== undefined) {
    throw new CredentialDecryptionError(
      "Stored credential has an invalid encrypted format",
    );
  }
  const key = keyRing?.keys.get(keyId);
  if (!key) {
    throw new CredentialDecryptionError(
      `Stored credential uses encryption key "${keyId}", which is not in JUNIOR_ENCRYPTION_KEYS`,
    );
  }
  const iv = Buffer.from(encodedIv, "base64url");
  const ciphertext = Buffer.from(encodedCiphertext, "base64url");
  if (iv.length !== IV_BYTES || ciphertext.length < AUTH_TAG_BYTES) {
    throw new CredentialDecryptionError(
      "Stored credential has an invalid encrypted format",
    );
  }
  let plaintext: string;
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(associatedData(recordKey));
    decipher.setAuthTag(ciphertext.subarray(-AUTH_TAG_BYTES));
    plaintext = Buffer.concat([
      decipher.update(ciphertext.subarray(0, -AUTH_TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    throw new CredentialDecryptionError(
      `Could not decrypt stored credential with key "${keyId}"`,
      { cause: error },
    );
  }
  return JSON.parse(plaintext) as unknown;
}
