/**
 * Encrypt secrets that Junior keeps at rest, such as provider credentials.
 *
 * AES-256-GCM with a key that HKDF derives from `JUNIOR_SECRET`. Each value
 * is bound to a context, usually its storage key, as additional authenticated
 * data. A value copied to another key does not decrypt.
 *
 * Rotation: the envelope holds a key id. New values always use the current
 * `JUNIOR_SECRET`. Values from a secret in `JUNIOR_SECRET_PREVIOUS` still
 * decrypt and report `stale`, so the owner can save them again with the
 * current key. A key id that matches no configured secret gives
 * `SecretKeyMismatchError`, not a tampering failure.
 *
 * Envelope: `jenc:v1:<keyId>:<iv>.<ciphertext>.<tag>` (base64url parts).
 */
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";

const ENVELOPE_PREFIX = "jenc:v1:";
const ALGORITHM = "aes-256-gcm";
const KEY_INFO = "junior.encryption.key.v1";
const KEY_ID_INFO = "junior.encryption.key-id.v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

interface EncryptionKey {
  id: string;
  key: Buffer;
}

/** A decrypted secret. `stale` means a previous key encrypted it. */
export interface DecryptedSecret {
  stale: boolean;
  text: string;
}

/** The envelope key id matches no configured `JUNIOR_SECRET`. */
export class SecretKeyMismatchError extends Error {
  constructor() {
    super("Stored secret was encrypted with an unknown JUNIOR_SECRET");
    this.name = "SecretKeyMismatchError";
  }
}

function deriveKey(secret: string): EncryptionKey {
  const derive = (info: string, length: number) =>
    Buffer.from(hkdfSync("sha256", secret, "", info, length));
  return {
    id: derive(KEY_ID_INFO, 6).toString("base64url"),
    key: derive(KEY_INFO, 32),
  };
}

function currentKey(): EncryptionKey {
  const secret = process.env.JUNIOR_SECRET?.trim();
  if (!secret) {
    throw new Error("Cannot encrypt stored secrets (set JUNIOR_SECRET)");
  }
  return deriveKey(secret);
}

/** Retired secrets, comma-separated. They only decrypt. */
function previousKeys(): EncryptionKey[] {
  return (process.env.JUNIOR_SECRET_PREVIOUS ?? "")
    .split(",")
    .map((secret) => secret.trim())
    .filter(Boolean)
    .map(deriveKey);
}

function additionalData(context: string): Buffer {
  return Buffer.from(`${ENVELOPE_PREFIX}${context}`, "utf8");
}

/** Check whether a stored value is an encryption envelope. */
export function isEncryptedSecret(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(ENVELOPE_PREFIX);
}

/** Encrypt one secret and bind it to `context`, such as its storage key. */
export function encryptSecret(plaintext: string, context: string): string {
  const { id, key } = currentKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(additionalData(context));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const parts = [iv, ciphertext, cipher.getAuthTag()].map((part) =>
    part.toString("base64url"),
  );
  return `${ENVELOPE_PREFIX}${id}:${parts.join(".")}`;
}

/** Decrypt an `encryptSecret` envelope with the same `context`. */
export function decryptSecret(
  envelope: string,
  context: string,
): DecryptedSecret {
  if (!isEncryptedSecret(envelope)) {
    throw new Error("Stored secret is not an encryption envelope");
  }
  const [keyId, payload] = envelope.slice(ENVELOPE_PREFIX.length).split(":");
  const [iv, ciphertext, tag] = (payload ?? "")
    .split(".")
    .map((part) => Buffer.from(part, "base64url"));
  if (!keyId || !iv || !ciphertext || !tag || tag.length !== TAG_BYTES) {
    throw new Error("Stored secret envelope is malformed");
  }
  const current = currentKey();
  const match =
    keyId === current.id
      ? current
      : previousKeys().find((candidate) => candidate.id === keyId);
  if (!match) throw new SecretKeyMismatchError();
  const decipher = createDecipheriv(ALGORITHM, match.key, iv, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(additionalData(context));
  decipher.setAuthTag(tag);
  const text = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
  return { stale: match !== current, text };
}
