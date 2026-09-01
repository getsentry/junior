import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardIdentitySchema } from "../src/api/schema";
import { resetDashboardEnv } from "./dashboard-test-helpers";

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

describe("dashboard auth setup", () => {
  beforeEach(() => {
    resetDashboardEnv();
  });

  afterEach(() => {
    resetDashboardEnv();
  });

  it("uses JUNIOR_SECRET as the default Better Auth secret", async () => {
    process.env.JUNIOR_SECRET = "junior-secret";
    const { createDashboardAuth } = await import("../src/auth");

    expect(() =>
      createDashboardAuth({
        authPath: "/api/auth",
        trustedOrigins: [],
      }),
    ).toThrow("GOOGLE_CLIENT_ID is required for Junior dashboard auth");
  });

  it("defaults dashboard auth to the local development URL", async () => {
    process.env.JUNIOR_SECRET = "junior-secret";
    process.env.GOOGLE_CLIENT_ID = "google-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "google-client-secret";
    const { createDashboardAuth } = await import("../src/auth");

    expect(() =>
      createDashboardAuth({
        authPath: "/api/auth",
        trustedOrigins: [],
      }),
    ).not.toThrow();
  });

  it("derives the Better Auth base URL from Junior deployment env", async () => {
    process.env.JUNIOR_SECRET = "junior-secret";
    process.env.GOOGLE_CLIENT_ID = "google-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "google-client-secret";
    process.env.JUNIOR_BASE_URL = "https://junior.example.com";
    const { createDashboardAuth } = await import("../src/auth");

    expect(() =>
      createDashboardAuth({
        authPath: "/api/auth",
        trustedOrigins: [],
      }),
    ).not.toThrow();
  });

  it("preserves the Better Auth OAuth state cookie during Google sign-in", async () => {
    const { createDashboardAuth } = await import("../src/auth");
    const auth = createDashboardAuth({
      authPath: "/api/auth",
      googleClientId: "google-client-id",
      googleClientSecret: "google-client-secret",
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [],
    });

    const response = await auth.signInWithGoogle(
      new Request("http://localhost/auth/login"),
      "http://localhost/",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("accounts.google.com");
    expect(response.headers.get("set-cookie")).toContain("oauth_state");
  });
});
