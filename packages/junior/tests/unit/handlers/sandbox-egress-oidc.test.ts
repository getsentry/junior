import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupSandboxEgressProxyTest,
  createRemoteJWKSetMock,
  decodeJwtMock,
  EGRESS_ID,
  jwtVerifyMock,
  setupSandboxEgressProxyTest,
  verifyVercelSandboxOidcToken,
} from "../../fixtures/sandbox-egress-proxy";

describe("sandbox egress OIDC verification", () => {
  beforeEach(async () => {
    await setupSandboxEgressProxyTest();
  });

  afterEach(async () => {
    await cleanupSandboxEgressProxyTest();
  });

  it("caches Vercel OIDC discovery metadata by issuer", async () => {
    decodeJwtMock.mockReturnValue({
      iss: "https://oidc.vercel.com/cache-test",
    });
    jwtVerifyMock.mockResolvedValue({
      payload: {
        sandbox_id: EGRESS_ID,
      },
    });
    const fetchMock = vi.fn(async (_url: URL | string, _init?: RequestInit) =>
      Response.json({
        jwks_uri: "https://oidc.vercel.com/cache-test/jwks",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await verifyVercelSandboxOidcToken("signed-token-1");
    await verifyVercelSandboxOidcToken("signed-token-2");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual({ redirect: "error" });
    expect(createRemoteJWKSetMock).toHaveBeenCalledTimes(1);
  });

  it("verifies sandbox tokens without assuming the deployment OIDC audience", async () => {
    decodeJwtMock.mockReturnValue({
      iss: "https://oidc.vercel.com/acme",
    });
    jwtVerifyMock.mockResolvedValue({
      payload: {
        aud: "sandbox-proxy-audience",
        owner_id: "different-team",
        project_id: "different-project",
        sandbox_id: EGRESS_ID,
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          jwks_uri: "https://oidc.vercel.com/acme/jwks",
        }),
      ),
    );

    await verifyVercelSandboxOidcToken("signed-token");

    expect(jwtVerifyMock).toHaveBeenCalledWith(
      "signed-token",
      expect.anything(),
      {
        issuer: "https://oidc.vercel.com/acme",
      },
    );
  });

  it("rejects non-HTTPS Vercel OIDC JWKS metadata", async () => {
    decodeJwtMock.mockReturnValue({
      iss: "https://oidc.vercel.com/bad-jwks",
    });
    const fetchMock = vi.fn(async () =>
      Response.json({
        jwks_uri: "http://oidc.vercel.com/bad-jwks/jwks",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyVercelSandboxOidcToken("signed-token")).rejects.toThrow(
      "jwks_uri",
    );

    expect(createRemoteJWKSetMock).not.toHaveBeenCalled();
    expect(jwtVerifyMock).not.toHaveBeenCalled();
  });
});
