import type { ResolveOAuthAccountHookContext } from "@sentry/junior-plugin-api";
import { describe, expect, it } from "vitest";
import { sentryPlugin } from "../src";

function resolveAccount(tokenResponse: Record<string, unknown>) {
  return sentryPlugin().hooks?.resolveOAuthAccount?.({
    tokenResponse,
    tokens: { accessToken: "user-token", refreshToken: "refresh-token" },
  } as ResolveOAuthAccountHookContext);
}

describe("sentry OAuth account", () => {
  it("reads the Sentry user from the token response", () => {
    expect(
      resolveAccount({
        access_token: "user-token",
        user: { id: "42", name: "Jane Doe", email: "jane@example.com" },
      }),
    ).toEqual({ displayName: "Jane Doe", id: "42", label: "jane@example.com" });
  });

  it("returns no account when the token response has no user", () => {
    expect(resolveAccount({ access_token: "user-token" })).toBeUndefined();
  });
});
