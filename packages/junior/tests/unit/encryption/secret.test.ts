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
    expect(decryptSecret(envelope, "oauth-token:U1:github")).toEqual({
      stale: false,
      text: "access-token",
    });
    expect(() => decryptSecret(envelope, "oauth-token:U2:github")).toThrow(
      "Unsupported state or unable to authenticate data",
    );
  });

  it("decrypts with a previous JUNIOR_SECRET and reports it stale", () => {
    const envelope = encryptSecret("access-token", "key");
    vi.stubEnv("JUNIOR_SECRET", "rotated-secret");

    expect(() => decryptSecret(envelope, "key")).toThrow(
      SecretKeyMismatchError,
    );

    vi.stubEnv("JUNIOR_SECRET_PREVIOUS", "older-secret, junior-test-secret");
    expect(decryptSecret(envelope, "key")).toEqual({
      stale: true,
      text: "access-token",
    });
  });
});
