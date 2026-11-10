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

/** One decrypted value. `stale` means the owner should save it again. */
export interface EncryptedStateRead {
  stale: boolean;
  value: unknown;
}

/**
 * Decrypt one stored envelope. The storage key is the encryption context.
 * A value from an unknown `JUNIOR_SECRET` reads as missing, so the owner asks
 * for the credential again and saves it with the current key.
 */
function decode(key: string, envelope: string): EncryptedStateRead | undefined {
  try {
    const { stale, text } = decryptSecret(envelope, key);
    return { stale, value: JSON.parse(text) };
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
      // A value that is not an envelope, such as one saved before
      // encryption, reads as missing.
      if (!isEncryptedSecret(stored)) return undefined;
      return decode(key, stored)?.value;
    },
    async set(key, value, ttlMs) {
      await state.set(key, encryptSecret(JSON.stringify(value), key), ttlMs);
    },
  };
}

/**
 * Read a value and report whether it is stale: encrypted with a key from
 * `JUNIOR_SECRET_PREVIOUS`, or saved before encryption. Long-lived owners
 * save stale values again, so they move to the current key.
 */
export async function readEncryptedState(
  state: StateAdapter,
  key: string,
): Promise<EncryptedStateRead | undefined> {
  const stored = await state.get<unknown>(key);
  if (stored === null || stored === undefined) return undefined;
  // TODO(dcramer): Delete after no plaintext credential keys remain.
  if (!isEncryptedSecret(stored)) return { stale: true, value: stored };
  return decode(key, stored);
}
