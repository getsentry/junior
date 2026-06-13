import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeSandboxEgressCredentialToken,
  ALL,
  cleanupSandboxEgressProxyTest,
  egressRequest,
  isSandboxEgressForwardedRequest,
  issueProviderCredentialLeaseMock,
  mockSentryLease,
  proxy,
  proxySandboxEgressRequest,
  SANDBOX_EGRESS_PROXY_PATH,
  setSandboxEgressUserActor,
  setupSandboxEgressProxyTest,
} from "../../fixtures/sandbox/egress-proxy";

describe("sandbox egress forwarding", () => {
  beforeEach(async () => {
    await setupSandboxEgressProxyTest();
  });

  afterEach(async () => {
    await cleanupSandboxEgressProxyTest();
  });

  it("requires OIDC before forwarded routing details", async () => {
    const response = await ALL(
      new Request("https://junior.example.com/api/0/issues/"),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Missing Vercel Sandbox OIDC token",
    });
  });

  it("forwards repeated authorized sandbox requests with credential headers", async () => {
    setSandboxEgressUserActor();
    mockSentryLease();

    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      expect(String(url)).toBe("https://sentry.io/api/0/issues/?query=foo");
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer sentry-token",
      );
      expect(new Headers(init?.headers).get("cookie")).toBe("session=sandbox");
      expect(new Headers(init?.headers).get("x-api-key")).toBe("sandbox-key");
      expect(new Headers(init?.headers).get("x-forwarded-for")).toBe(
        "127.0.0.1",
      );
      expect(new Headers(init?.headers).get("host")).toBeNull();
      expect(
        new Headers(init?.headers).get("vercel-sandbox-oidc-token"),
      ).toBeNull();
      return new Response("ok", { status: 200 });
    });

    const request = egressRequest({
      path: "/api/0/issues/?query=foo",
      scheme: "HTTPS",
      headers: {
        authorization: "Bearer sandbox-token",
        cookie: "session=sandbox",
        host: "junior.example.com",
        "x-api-key": "sandbox-key",
        "x-forwarded-for": "127.0.0.1",
      },
    });

    const response = await proxy(request, fetchMock as typeof fetch);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("ok");

    const repeated = await proxy(
      new Request(request.url, {
        method: "GET",
        headers: request.headers,
      }),
      fetchMock as typeof fetch,
    );

    expect(repeated.status).toBe(200);
    await expect(repeated.text()).resolves.toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(issueProviderCredentialLeaseMock).toHaveBeenCalledTimes(1);
  });

  it("prefers Vercel forwarded path over the normalized proxy URL path", async () => {
    setSandboxEgressUserActor();
    mockSentryLease();

    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      expect(String(url)).toBe(
        "https://sentry.io/api/0/organizations/sentry/?query=is%3Aunresolved",
      );
      expect(
        new Headers(init?.headers).get("vercel-forwarded-path"),
      ).toBeNull();
      return new Response("ok", { status: 200 });
    });

    const response = await proxy(
      egressRequest({
        path: "/api/0/organizations/sentry",
        headers: {
          "vercel-forwarded-path":
            "/api/0/organizations/sentry/?query=is%3Aunresolved",
        },
      }),
      fetchMock as typeof fetch,
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(issueProviderCredentialLeaseMock).toHaveBeenCalledTimes(1);
  });

  it("rejects sandbox egress requests without a forwarded path", async () => {
    setSandboxEgressUserActor();

    const fetchMock = vi.fn();
    const response = await proxy(
      egressRequest({
        forwardedPath: null,
        proxyPath: `${SANDBOX_EGRESS_PROXY_PATH}/${activeSandboxEgressCredentialToken()}`,
      }),
      fetchMock as typeof fetch,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Missing forwarded path",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(issueProviderCredentialLeaseMock).not.toHaveBeenCalled();
  });

  it("recognizes root-path forwarded sandbox proxy requests", () => {
    expect(isSandboxEgressForwardedRequest(egressRequest())).toBe(true);
    expect(
      isSandboxEgressForwardedRequest(
        new Request("https://junior.example.com/api/0/issues/", {
          headers: {
            "vercel-forwarded-host": "sentry.io",
            "vercel-forwarded-scheme": "https",
          },
        }),
      ),
    ).toBe(false);
  });

  it("does not synthesize an empty body for bodyless methods", async () => {
    setSandboxEgressUserActor();
    mockSentryLease();

    const fetchMock = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      expect(init?.method).toBe("DELETE");
      expect(init).not.toHaveProperty("body");
      return new Response("ok", { status: 200 });
    });

    const response = await proxy(
      egressRequest({ method: "DELETE" }),
      fetchMock as typeof fetch,
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("forwards upstream response headers to the sandbox", async () => {
    setSandboxEgressUserActor();
    mockSentryLease();

    const upstreamHeaders = new Headers();
    upstreamHeaders.append("set-cookie", "session=provider; Path=/");
    upstreamHeaders.append("x-request-id", "req-123");

    const response = await proxy(
      egressRequest(),
      vi.fn(
        async () => new Response("ok", { headers: upstreamHeaders }),
      ) as typeof fetch,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBe("session=provider; Path=/");
    expect(response.headers.get("x-request-id")).toBe("req-123");
  });

  it("drops upstream encoding headers after host fetch decodes the body", async () => {
    setSandboxEgressUserActor();
    mockSentryLease();

    const response = await proxy(
      egressRequest(),
      vi.fn(
        async () =>
          new Response("ok", {
            headers: {
              "content-encoding": "gzip",
              "content-length": "999",
              "x-request-id": "req-123",
            },
          }),
      ) as typeof fetch,
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("ok");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("x-request-id")).toBe("req-123");
  });

  it("rejects forwarded hosts with embedded ports", async () => {
    const fetchMock = vi.fn();

    const response = await proxy(
      egressRequest({ host: "sentry.io:8080", port: "443" }),
      fetchMock as typeof fetch,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid forwarded host",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects invalid forwarded ports", async () => {
    const fetchMock = vi.fn();

    const response = await proxy(
      egressRequest({ port: "65536" }),
      fetchMock as typeof fetch,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid forwarded port",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects invalid forwarded paths", async () => {
    const fetchMock = vi.fn();

    const response = await proxy(
      egressRequest({
        headers: {
          "vercel-forwarded-path": "//evil.example/api/0/issues/",
        },
      }),
      fetchMock as typeof fetch,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid forwarded path",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(issueProviderCredentialLeaseMock).not.toHaveBeenCalled();
  });

  it("requires the verified OIDC token to identify the sandbox session", async () => {
    const fetchMock = vi.fn();

    const response = await proxySandboxEgressRequest(egressRequest(), {
      fetch: fetchMock as typeof fetch,
      verifyOidc: async () => ({ sub: "sandbox" }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Vercel Sandbox OIDC token did not include sandbox_id",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects plaintext forwarded schemes before credential injection", async () => {
    const fetchMock = vi.fn();

    const response = await proxy(
      egressRequest({ scheme: "http" }),
      fetchMock as typeof fetch,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Forwarded scheme must be https",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(issueProviderCredentialLeaseMock).not.toHaveBeenCalled();
  });

  it("requires the Vercel forwarded scheme header", async () => {
    const fetchMock = vi.fn();

    const response = await proxy(
      egressRequest({ scheme: null }),
      fetchMock as typeof fetch,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Missing forwarded scheme",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(issueProviderCredentialLeaseMock).not.toHaveBeenCalled();
  });
});
