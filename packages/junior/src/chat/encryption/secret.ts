/**
 * Encrypt secrets at rest with AES-256-GCM and `JUNIOR_ENCRYPTION_KEYS`. The
 * context, usually the storage key, and key id are AAD, so a copied value does
 * not decrypt. New values use the active key; an inactive key reports `stale`.
 * No per-value salt: keys are random, each value has a random IV, and the AAD
 * names the owner. Envelope: `jenc:v1:<keyId>:<iv>.<ciphertext>.<tag>`.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getChatConfig } from "@/chat/config";
import {
  createEncryptionKeyring,
  type EncryptionKeyring,
} from "@/chat/encryption/keyring";

const ENVELOPE_PREFIX = "jenc:v1:";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** A decrypted secret. `stale` means a key that is not active encrypted it. */
export interface DecryptedSecret {
  stale: boolean;
  text: string;
}

/** A stored secret that cannot be decrypted with the configured keys. */
export class UnreadableSecretError extends Error {
  readonly reason: "unknown_key" | "invalid";

  constructor(reason: "unknown_key" | "invalid") {
    super(
      reason === "unknown_key"
        ? "Stored secret was encrypted with a key that is not configured"
        : "Stored secret is malformed or failed authentication",
    );
    this.name = "UnreadableSecretError";
    this.reason = reason;
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
  keyring: EncryptionKeyring = createEncryptionKeyring(
    getChatConfig().encryption,
  ),
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
  keyring: EncryptionKeyring = createEncryptionKeyring(
    getChatConfig().encryption,
  ),
): DecryptedSecret {
  if (!isEncryptedSecret(envelope)) {
    throw new Error("Stored secret is not an encryption envelope");
  }
  const [keyId, payload] = envelope.slice(ENVELOPE_PREFIX.length).split(":");
  const [iv, ciphertext, tag] = (payload ?? "")
    .split(".")
    .map((part) => Buffer.from(part, "base64url"));
  if (
    !keyId ||
    !iv ||
    iv.length !== IV_BYTES ||
    !ciphertext ||
    !tag ||
    tag.length !== TAG_BYTES
  ) {
    throw new UnreadableSecretError("invalid");
  }
  const match = keyring.keys.find((candidate) => candidate.id === keyId);
  if (!match) throw new UnreadableSecretError("unknown_key");
  const decipher = createDecipheriv(ALGORITHM, match.key, iv, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(additionalData(keyId, context));
  decipher.setAuthTag(tag);
  let text: string;
  try {
    text = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // GCM rejects altered ciphertext, a wrong tag, and a wrong context alike.
    throw new UnreadableSecretError("invalid");
  }
  return { stale: match.id !== keyring.active.id, text };
}
