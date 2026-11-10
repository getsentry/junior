/**
 * Encrypt secrets that Junior keeps at rest, such as provider credentials.
 *
 * AES-256-GCM with a key that HKDF derives from `JUNIOR_SECRET`. Each value
 * is bound to a context, usually its storage key, as additional authenticated
 * data. A value copied to another key does not decrypt. The envelope holds a
 * key id, so a changed `JUNIOR_SECRET` gives `SecretKeyMismatchError`, not a
 * tampering failure.
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

function deriveKey(): EncryptionKey {
  const secret = process.env.JUNIOR_SECRET?.trim();
  if (!secret) {
    throw new Error("Cannot encrypt stored secrets (set JUNIOR_SECRET)");
  }
  const derive = (info: string, length: number) =>
    Buffer.from(hkdfSync("sha256", secret, "", info, length));
  return {
    id: derive(KEY_ID_INFO, 6).toString("base64url"),
    key: derive(KEY_INFO, 32),
  };
}

/** The envelope was encrypted with a key from a different `JUNIOR_SECRET`. */
export class SecretKeyMismatchError extends Error {
  constructor() {
    super("Stored secret was encrypted with a different JUNIOR_SECRET");
    this.name = "SecretKeyMismatchError";
  }
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
  const { id, key } = deriveKey();
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
export function decryptSecret(envelope: string, context: string): string {
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
  const { id, key } = deriveKey();
  if (keyId !== id) throw new SecretKeyMismatchError();
  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(additionalData(context));
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}
