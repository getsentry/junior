import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  credentialTokenFromAuthorizationHeader,
  fingerprintCredentialToken,
  fingerprintLeaseAuthorization,
} from "@/chat/credentials/token-fingerprint";

function expectedFingerprint(token: string): string {
  return createHmac("sha256", "junior.credential-fingerprint.v1")
    .update(token, "utf8")
    .digest("hex")
    .slice(0, 12);
}

describe("token fingerprint helpers", () => {
  it("hashes tokens to a stable short fingerprint", () => {
    const token = "installation-token";
    expect(fingerprintCredentialToken(token)).toBe(expectedFingerprint(token));
  });

  it("recovers bearer and git smart-http basic tokens", () => {
    expect(
      credentialTokenFromAuthorizationHeader("Bearer installation-token"),
    ).toBe("installation-token");
    const basic = Buffer.from("x-access-token:installation-token").toString(
      "base64",
    );
    expect(credentialTokenFromAuthorizationHeader(`Basic ${basic}`)).toBe(
      "installation-token",
    );
  });

  it("fingerprints the first authorization header on a lease", () => {
    const fingerprint = fingerprintLeaseAuthorization([
      {
        headers: {
          Authorization: "Bearer installation-token",
        },
      },
    ]);
    expect(fingerprint).toBe(expectedFingerprint("installation-token"));
  });
});
