import { afterEach, describe, expect, it, vi } from "vitest";
import { dashboardIdentitySchema } from "../src/api/schema";

describe("dashboard auth config", () => {
  afterEach(() => {
    vi.doUnmock("better-auth/minimal");
    vi.resetModules();
  });

  it("requires a valid email for every dashboard identity", () => {
    expect(
      dashboardIdentitySchema.parse({
        user: { email: "person@example.com" },
      }),
    ).toEqual({ user: { email: "person@example.com" } });

    for (const email of [undefined, null, "not-an-email"]) {
      expect(
        dashboardIdentitySchema.safeParse({ user: { email } }).success,
      ).toBe(false);
    }
  });

  it("keeps Google account tokens out of persistent dashboard cookies", async () => {
    let capturedOptions: unknown;

    vi.doMock("better-auth/minimal", () => ({
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
