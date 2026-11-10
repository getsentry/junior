import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  SecretKeyMismatchError,
} from "@/chat/encryption/secret";

describe("encryptSecret", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("decrypts only with the context it was encrypted for", () => {
    const envelope = encryptSecret("access-token", "oauth-token:U1:github");

    expect(envelope).toMatch(/^jenc:v1:/);
    expect(envelope).not.toContain("access-token");
    expect(decryptSecret(envelope, "oauth-token:U1:github")).toBe(
      "access-token",
    );
    expect(() => decryptSecret(envelope, "oauth-token:U2:github")).toThrow(
      "Unsupported state or unable to authenticate data",
    );
  });

  it("reports a changed JUNIOR_SECRET as a key mismatch", () => {
    const envelope = encryptSecret("access-token", "key");
    vi.stubEnv("JUNIOR_SECRET", "rotated-secret");

    expect(() => decryptSecret(envelope, "key")).toThrow(
      SecretKeyMismatchError,
    );
  });
});
