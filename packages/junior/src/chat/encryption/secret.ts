/**
 * Encrypt secrets that Junior keeps at rest, such as provider credentials.
 *
 * AES-256-GCM with keys from `JUNIOR_ENCRYPTION_KEYS` (see `keyring.ts`).
 * Each value is bound to a context, usually its storage key, and to its key
 * id as additional authenticated data. A value copied to another key does not
 * decrypt.
 *
 * New values use the active key. Any listed key decrypts. A value from a key
 * that is not active reports `stale`, so its owner can save it again with the
 * active key. A key id that is not listed gives `SecretKeyMismatchError`, not
 * a tampering failure.
 *
 * There is no per-value salt. The keys are random, not passwords, and each
 * value has a random IV. The storage key in the AAD already names the
 * identity that owns the value.
 *
 * Envelope: `jenc:v1:<keyId>:<iv>.<ciphertext>.<tag>` (base64url parts).
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getChatConfig } from "@/chat/config";
import type { EncryptionKeyring } from "@/chat/encryption/keyring";

const ENVELOPE_PREFIX = "jenc:v1:";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** A decrypted secret. `stale` means a key that is not active encrypted it. */
export interface DecryptedSecret {
  stale: boolean;
  text: string;
}

/** The envelope key id is not in `JUNIOR_ENCRYPTION_KEYS`. */
export class SecretKeyMismatchError extends Error {
  constructor() {
    super("Stored secret was encrypted with a key that is not configured");
    this.name = "SecretKeyMismatchError";
  }
}

function additionalData(keyId: string, context: string): Buffer {
  return Buffer.from(`${ENVELOPE_PREFIX}${keyId}\0${context}`, "utf8");
}

/** Check whether a stored value is an encryption envelope. */
export function isEncryptedSecret(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(ENVELOPE_PREFIX);
}

/** Encrypt one secret with the active key and bind it to `context`. */
export function encryptSecret(
  plaintext: string,
  context: string,
  keyring: EncryptionKeyring = getChatConfig().encryption,
): string {
  const { id, key } = keyring.active;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(additionalData(id, context));
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
  keyring: EncryptionKeyring = getChatConfig().encryption,
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
  const match = keyring.keys.find((candidate) => candidate.id === keyId);
  if (!match) throw new SecretKeyMismatchError();
  const decipher = createDecipheriv(ALGORITHM, match.key, iv, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(additionalData(keyId, context));
  decipher.setAuthTag(tag);
  const text = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
  return { stale: match.id !== keyring.active.id, text };
}
