import { describe, expect, it } from "vitest";
import { readEncryptionKeyring } from "@/chat/encryption/keyring";
import {
  decryptSecret,
  encryptSecret,
  UnreadableSecretError,
} from "@/chat/encryption/secret";

const OLD_KEY = "old:yzdMjBLutb3SqjtwO1Lm3Cr2wN7FSGG8tzlRjvJc8Xg";
const NEW_KEY = "new:Wywm9DZHe0QkHOXon30I5fklwG0gdqLAzMViptFlvtI";

function unreadableReason(read: () => unknown): string | undefined {
  try {
    read();
  } catch (error) {
    if (error instanceof UnreadableSecretError) return error.reason;
    throw error;
  }
  return undefined;
}

describe("encryptSecret", () => {
  it("decrypts only with the context it was encrypted for", () => {
    const envelope = encryptSecret("access-token", "oauth-token:U1:github");

    expect(envelope).toMatch(/^jenc:v1:test:/);
    expect(envelope).not.toContain("access-token");
    expect(decryptSecret(envelope, "oauth-token:U1:github")).toEqual({
      stale: false,
      text: "access-token",
    });
    expect(
      unreadableReason(() => decryptSecret(envelope, "oauth-token:U2:github")),
    ).toBe("invalid");
  });

  it("rejects malformed and altered envelopes", () => {
    const envelope = encryptSecret("access-token", "key");
    const altered = `${envelope.slice(0, -4)}AAAA`;

    expect(unreadableReason(() => decryptSecret(altered, "key"))).toBe(
      "invalid",
    );
    expect(unreadableReason(() => decryptSecret("jenc:v1:test:x", "key"))).toBe(
      "invalid",
    );
  });

  it("decrypts with a key that is not active and reports it stale", () => {
    const oldOnly = readEncryptionKeyring({ JUNIOR_ENCRYPTION_KEYS: OLD_KEY });
    const rotated = readEncryptionKeyring({
      JUNIOR_ENCRYPTION_KEYS: `${NEW_KEY},${OLD_KEY}`,
      JUNIOR_ENCRYPTION_KEY_ID: "new",
    });
    const newOnly = readEncryptionKeyring({ JUNIOR_ENCRYPTION_KEYS: NEW_KEY });
    const envelope = encryptSecret("access-token", "key", oldOnly);

    expect(decryptSecret(envelope, "key", rotated)).toEqual({
      stale: true,
      text: "access-token",
    });
    expect(
      unreadableReason(() => decryptSecret(envelope, "key", newOnly)),
    ).toBe("unknown_key");
  });
});

describe("readEncryptionKeyring", () => {
  it.each([
    [{}, "JUNIOR_ENCRYPTION_KEYS is required"],
    [{ JUNIOR_ENCRYPTION_KEYS: "old:c2hvcnQ" }, 'key "old" must be 32 bytes'],
    [
      { JUNIOR_ENCRYPTION_KEYS: `${OLD_KEY},${OLD_KEY}` },
      "must not repeat a key id",
    ],
    [
      { JUNIOR_ENCRYPTION_KEYS: `${NEW_KEY},${OLD_KEY}` },
      "JUNIOR_ENCRYPTION_KEY_ID is required",
    ],
    [
      { JUNIOR_ENCRYPTION_KEYS: NEW_KEY, JUNIOR_ENCRYPTION_KEY_ID: "old" },
      'JUNIOR_ENCRYPTION_KEY_ID "old" is not in JUNIOR_ENCRYPTION_KEYS',
    ],
  ])("rejects an invalid keyring", (env, message) => {
    expect(() => readEncryptionKeyring(env)).toThrow(message);
  });
});
