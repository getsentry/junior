import { afterEach, describe, expect, it, vi } from "vitest";

describe("dashboard auth config", () => {
  afterEach(() => {
    vi.doUnmock("better-auth");
    vi.resetModules();
  });

  it("keeps Google account tokens out of persistent dashboard cookies", async () => {
    let capturedOptions: unknown;

    vi.doMock("better-auth", () => ({
      betterAuth(options: unknown) {
        capturedOptions = options;
        return {
          handler: vi.fn(async () => new Response(null)),
          api: {
            getSession: vi.fn(async () => null),
            signInSocial: vi.fn(async () => ({
              headers: new Headers(),
              response: { url: "https://accounts.google.com/o/oauth2/v2/auth" },
            })),
          },
        };
      },
    }));

    const { createDashboardAuth } = await import("../src/auth");

    createDashboardAuth({
      authPath: "/api/auth",
      googleClientId: "google-client-id",
      googleClientSecret: "google-client-secret",
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [],
    });

    expect(capturedOptions).toMatchObject({
      account: {
        storeAccountCookie: false,
        storeStateStrategy: "cookie",
        updateAccountOnSignIn: false,
      },
      session: {
        cookieCache: {
          strategy: "jwe",
        },
      },
    });
    expect(capturedOptions).not.toHaveProperty("database");
  });
});
