import type { StateAdapter } from "chat";
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
  SecretKeyMismatchError,
} from "@/chat/encryption/secret";

/** Key-value state that keeps each value encrypted at rest. */
export interface EncryptedState {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, ttlMs?: number): Promise<void>;
}

/**
 * Decrypt one stored envelope. The storage key is the encryption context.
 * A value from a previous `JUNIOR_SECRET` reads as missing, so the owner asks
 * for the credential again and saves it with the current key.
 */
function decode(key: string, envelope: string): unknown {
  try {
    return JSON.parse(decryptSecret(envelope, key));
  } catch (error) {
    if (error instanceof SecretKeyMismatchError) return undefined;
    throw error;
  }
}

/**
 * Wrap a state adapter so values are JSON-encoded and encrypted before they
 * reach storage. Keys and TTLs stay readable. Use it for credentials and
 * other secrets; delete, lock, and keep plain state on the base adapter.
 */
export function createEncryptedState(state: StateAdapter): EncryptedState {
  return {
    async get(key) {
      const stored = await state.get<unknown>(key);
      if (stored === null || stored === undefined) return undefined;
      if (!isEncryptedSecret(stored)) {
        throw new Error("Stored value is not encrypted");
      }
      return decode(key, stored);
    },
    async set(key, value, ttlMs) {
      await state.set(key, encryptSecret(JSON.stringify(value), key), ttlMs);
    },
  };
}

/**
 * Read a value that may predate encryption. `plaintext` is true for a value
 * saved before encryption, so the owner can save it again encrypted.
 *
 * TODO(dcramer): Delete after no plaintext credential keys remain. Use
 * `EncryptedState.get` then.
 */
export async function readEncryptedOrPlaintext(
  state: StateAdapter,
  key: string,
): Promise<{ plaintext: boolean; value: unknown } | undefined> {
  const stored = await state.get<unknown>(key);
  if (stored === null || stored === undefined) return undefined;
  if (!isEncryptedSecret(stored)) return { plaintext: true, value: stored };
  const value = decode(key, stored);
  return value === undefined ? undefined : { plaintext: false, value };
}
