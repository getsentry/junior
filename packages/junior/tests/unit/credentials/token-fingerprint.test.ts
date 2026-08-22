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
    expect(fingerprintCredentialToken("installation-token")).toBe(
      expectedFingerprint("installation-token"),
    );
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

  it("fingerprints lease authorization headers", () => {
    expect(
      fingerprintLeaseAuthorization([
        { headers: { Authorization: "Bearer installation-token" } },
      ]),
    ).toBe(expectedFingerprint("installation-token"));
  });
});
