import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSignInAllowlist } from "@/chat/sign-in/allowlist";
import { createSignInAuth } from "@/chat/sign-in/auth";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sign-in allowlist", () => {
  it("reads dashboard env lists as JSON arrays or comma separated values", () => {
    vi.stubEnv(
      "JUNIOR_DASHBOARD_GOOGLE_DOMAINS",
      '["Sentry.io", "example.com"]',
    );
    vi.stubEnv(
      "JUNIOR_DASHBOARD_ALLOWED_EMAILS",
      "a@example.net, b@example.net",
    );

    expect(resolveSignInAllowlist()).toEqual({
      domains: ["sentry.io", "example.com"],
      emails: ["a@example.net", "b@example.net"],
    });
  });

  it("rejects an env list that is not a JSON string array", () => {
    vi.stubEnv("JUNIOR_DASHBOARD_GOOGLE_DOMAINS", "[1]");

    expect(() => resolveSignInAllowlist()).toThrow(
      "JUNIOR_DASHBOARD_GOOGLE_DOMAINS must be a JSON string array",
    );
  });
});

describe("sign-in session", () => {
  it("limits the Google account chooser only when the allowlist is one domain", async () => {
    const googleUrl = async (domains: string[], emails: string[]) => {
      const auth = createSignInAuth({
        agentName: "junior",
        allowlist: { domains, emails },
        authPath: "/api/auth",
        baseURL: "https://junior.example.com",
        googleClientId: "google-client",
        googleClientSecret: "google-secret",
        secret: "0123456789abcdef0123456789abcdef",
        trustedOrigins: [],
      });
      const response = await auth.signInWithGoogle(
        new Request("https://junior.example.com/auth/login"),
        "https://junior.example.com/",
      );
      expect(response.headers.get("set-cookie")).toContain("oauth_state");
      return new URL(response.headers.get("location")!);
    };

    expect((await googleUrl(["example.com"], [])).searchParams.get("hd")).toBe(
      "example.com",
    );
    expect(
      (
        await googleUrl(["example.com"], ["person@partner.dev"])
      ).searchParams.has("hd"),
    ).toBe(false);
  });
});
