import { describe, expect, it } from "vitest";
import {
  CredentialDecryptionError,
  decryptStoredCredential,
  encryptStoredCredential,
  readCredentialKeyRing,
  storedCredentialKeyId,
} from "@/chat/credentials/encryption";
import { reencryptStoredValue } from "@/chat/credentials/sweep";

const KEY_1 = Buffer.alloc(32, 1).toString("base64");
const KEY_2 = Buffer.alloc(32, 2).toString("base64");
const RECORD_KEY = "oauth-token:U123:github";
const TOKENS = { accessToken: "access", refreshToken: "refresh" };

function keyRing(keys: string, activeKeyId?: string) {
  const ring = readCredentialKeyRing({
    JUNIOR_ENCRYPTION_KEYS: keys,
    JUNIOR_ENCRYPTION_KEY_ID: activeKeyId,
  });
  if (!ring) throw new Error("expected a key ring");
  return ring;
}

describe("credential encryption", () => {
  it("decrypts only for the record it was written for", () => {
    const ring = keyRing(`k1:${KEY_1}`, "k1");
    const encrypted = encryptStoredCredential(TOKENS, RECORD_KEY, ring);

    expect(encrypted).toMatch(/^jenc:v1:k1:/);
    expect(encrypted).not.toContain("access");
    expect(decryptStoredCredential(encrypted, RECORD_KEY, ring)).toEqual(
      TOKENS,
    );
    expect(() =>
      decryptStoredCredential(encrypted, "oauth-token:U999:github", ring),
    ).toThrow(CredentialDecryptionError);
    expect(() =>
      decryptStoredCredential(encrypted, RECORD_KEY, undefined),
    ).toThrow('encryption key "k1", which is not in JUNIOR_ENCRYPTION_KEYS');
  });

  it("keeps plain text until a key is active", () => {
    expect(readCredentialKeyRing({})).toBeUndefined();
    const loadedOnly = keyRing(`k1:${KEY_1}`);
    expect(encryptStoredCredential(TOKENS, RECORD_KEY, loadedOnly)).toBe(
      TOKENS,
    );
    expect(decryptStoredCredential(TOKENS, RECORD_KEY, loadedOnly)).toBe(
      TOKENS,
    );
  });

  it.each([
    [{ JUNIOR_ENCRYPTION_KEY_ID: "k1" }, "JUNIOR_ENCRYPTION_KEYS is empty"],
    [{ JUNIOR_ENCRYPTION_KEYS: KEY_1 }, "entry 1 must look like"],
    [{ JUNIOR_ENCRYPTION_KEYS: "k1:not base64!" }, 'key "k1" must be 32 bytes'],
    [
      { JUNIOR_ENCRYPTION_KEYS: `k1:${Buffer.alloc(16).toString("base64")}` },
      'key "k1" must be 32 bytes',
    ],
    [
      { JUNIOR_ENCRYPTION_KEYS: `k1:${KEY_1},k1:${KEY_2}` },
      'key id "k1" more than once',
    ],
    [
      { JUNIOR_ENCRYPTION_KEYS: `k1:${KEY_1}`, JUNIOR_ENCRYPTION_KEY_ID: "k2" },
      'JUNIOR_ENCRYPTION_KEY_ID "k2" is not in JUNIOR_ENCRYPTION_KEYS',
    ],
  ])("rejects invalid key configuration %#", (env, message) => {
    expect(() => readCredentialKeyRing(env)).toThrow(message);
  });

  it("re-encrypts plain text and older keys with the active key", () => {
    const rotated = keyRing(`k2:${KEY_2},k1:${KEY_1}`, "k2");
    const oldRing = keyRing(`k1:${KEY_1}`, "k1");

    for (const stored of [
      TOKENS,
      encryptStoredCredential(TOKENS, RECORD_KEY, oldRing),
    ]) {
      const next = reencryptStoredValue(
        JSON.stringify(stored),
        RECORD_KEY,
        rotated,
      );
      const value: unknown = JSON.parse(next!);
      expect(storedCredentialKeyId(value)).toBe("k2");
      expect(decryptStoredCredential(value, RECORD_KEY, rotated)).toEqual(
        TOKENS,
      );
      expect(reencryptStoredValue(next!, RECORD_KEY, rotated)).toBeUndefined();
    }
  });
});
