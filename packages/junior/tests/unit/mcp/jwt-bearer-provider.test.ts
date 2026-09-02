import { generateKeyPairSync } from "node:crypto";
import { decodeProtectedHeader, jwtVerify } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { JwtBearerMcpClientProvider } from "@/chat/mcp/jwt-bearer-provider";

describe("JwtBearerMcpClientProvider", () => {
  afterEach(() => {
    delete process.env.TEST_MCP_PRIVATE_KEY;
  });

  it("prepares a jwt-bearer grant with a verifiable signed assertion", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    process.env.TEST_MCP_PRIVATE_KEY = privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString();
    const provider = new JwtBearerMcpClientProvider(
      "https://mcp.example.test/mcp",
      {
        issuer: "https://junior.example.test",
        keyId: "junior-1",
        privateKeyEnv: "TEST_MCP_PRIVATE_KEY",
        subject: "junior",
      },
    );
    provider.saveClientInformation({ client_id: "client-123" });

    const params = await provider.prepareTokenRequest();

    expect(params.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    );
    const assertion = params.get("assertion");
    expect(assertion).toBeTruthy();
    // The server rejects assertions without this exact typ and a JWKS-matching kid.
    expect(decodeProtectedHeader(assertion!)).toMatchObject({
      alg: "RS256",
      kid: "junior-1",
      typ: "oauth-id-jag+jwt",
    });
    const { payload } = await jwtVerify(assertion!, publicKey, {
      issuer: "https://junior.example.test",
      audience: "https://mcp.example.test/",
    });
    expect(payload).toMatchObject({
      sub: "junior",
      client_id: "client-123",
      resource: "https://mcp.example.test/mcp",
    });
    expect(payload.jti).toBeTruthy();
  });
});
