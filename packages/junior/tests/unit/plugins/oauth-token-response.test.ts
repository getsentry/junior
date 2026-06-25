import { describe, expect, it, vi } from "vitest";
import { parseOAuthTokenResponse } from "@/chat/plugins/auth/oauth-request";

describe("parseOAuthTokenResponse", () => {
  it("uses fallback scope when provider omits scope field", () => {
    const result = parseOAuthTokenResponse(
      { access_token: "access", refresh_token: "refresh" },
      "read:org repo",
    );
    expect(result.scope).toBe("read:org repo");
  });

  it("uses response scope when provider returns a non-empty scope", () => {
    const result = parseOAuthTokenResponse(
      { access_token: "access", refresh_token: "refresh", scope: "repo" },
      "read:org repo",
    );
    expect(result.scope).toBe("repo");
  });

  it("rejects an empty response scope by default", () => {
    expect(() =>
      parseOAuthTokenResponse(
        { access_token: "access", refresh_token: "refresh", scope: "" },
        "read:org repo",
      ),
    ).toThrow("OAuth token response returned empty scope");
  });

  it("uses fallback scope when provider returns empty scope and treatEmptyScopeAsUnreported is true", () => {
    const result = parseOAuthTokenResponse(
      { access_token: "access", refresh_token: "refresh", scope: "" },
      "read:org repo",
      { treatEmptyScopeAsUnreported: true },
    );
    expect(result.scope).toBe("read:org repo");
  });

  it("returns undefined when treatEmptyScopeAsUnreported is true but no fallback scope is configured", () => {
    const result = parseOAuthTokenResponse(
      { access_token: "access", refresh_token: "refresh", scope: "" },
      undefined,
      { treatEmptyScopeAsUnreported: true },
    );
    expect(result.scope).toBeUndefined();
  });

  it("preserves response scope even when treatEmptyScopeAsUnreported is true and response scope is non-empty", () => {
    const result = parseOAuthTokenResponse(
      { access_token: "access", refresh_token: "refresh", scope: "repo gist" },
      "read:org",
      { treatEmptyScopeAsUnreported: true },
    );
    expect(result.scope).toBe("gist repo");
  });

  it("records refresh token expiry separately from access token expiry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-24T00:00:00Z"));

    try {
      const result = parseOAuthTokenResponse({
        access_token: "access",
        expires_in: 28_800,
        refresh_token: "refresh",
        refresh_token_expires_in: 15_897_600,
      });

      expect(result.expiresAt).toBe(new Date("2026-06-24T08:00:00Z").getTime());
      expect(result.refreshTokenExpiresAt).toBe(
        new Date("2026-12-25T00:00:00Z").getTime(),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
