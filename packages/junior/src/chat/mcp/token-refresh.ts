/**
 * One MCP token refresh at a time for each person and provider.
 *
 * Providers such as Notion rotate the refresh token on each refresh and
 * revoke the whole grant when a retired refresh token comes back. A Turn
 * and a link card read can both find an expired access token at once, so
 * every refresh of a stored person login runs under one lock. A caller
 * that waited gets the tokens that the first caller saved, and its retired
 * refresh token never reaches the provider.
 */
import { getStateAdapter } from "@/chat/state/adapter";
import { fenceLock, withLock } from "@/chat/state/locks";
import {
  getMcpStoredOAuthCredentials,
  putMcpStoredOAuthCredentials,
} from "./auth-store";

// Long enough for discovery-free token calls on a slow provider.
const REFRESH_LOCK_TTL_MS = 30_000;
const REFRESH_WAIT_MS = 30_000;

/** The person and provider whose stored login a refresh changes. */
export interface McpLoginOwner {
  provider: string;
  userId: string;
}

function refreshTokenOf(body: unknown): string | undefined {
  const params =
    body instanceof URLSearchParams
      ? body
      : typeof body === "string"
        ? new URLSearchParams(body)
        : undefined;
  return params?.get("grant_type") === "refresh_token"
    ? (params.get("refresh_token") ?? undefined)
    : undefined;
}

/**
 * Wrap the fetch of an MCP client so that each refresh-token request for
 * this login runs under the shared lock. Other requests pass through.
 */
export function serializeMcpTokenRefresh(
  owner: () => Promise<McpLoginOwner>,
  fetchFn: typeof fetch = globalThis.fetch,
): typeof fetch {
  // The access token of this client's last MCP request: the one that the
  // provider rejected when a refresh follows.
  let sentAccessToken: string | undefined;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const sentRefreshToken = refreshTokenOf(init?.body);
    if (!sentRefreshToken) {
      // Discovery requests carry no token.
      const authorization = new Headers(init?.headers).get("authorization");
      if (authorization) {
        sentAccessToken = authorization.replace(/^Bearer\s+/i, "");
      }
      return await fetchFn(input, init);
    }
    const { provider, userId } = await owner();
    const state = getStateAdapter();
    await state.connect();
    const attempt = await withLock(
      state,
      `mcp-oauth-refresh:${userId}:${provider}`,
      async (lock) => {
        const stored = await getMcpStoredOAuthCredentials(userId, provider);
        const current = stored?.tokens;
        if (!current) {
          // The person unlinked while this caller waited. A refresh must
          // not bring the login back.
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        if (
          (current.refresh_token &&
            current.refresh_token !== sentRefreshToken) ||
          (sentAccessToken && current.access_token !== sentAccessToken)
        ) {
          // Another caller refreshed after this one sent its request. The
          // SDK saves these tokens again, which changes nothing.
          return Response.json(current);
        }
        const response = await fetchFn(input, init);
        if (!response.ok) return response;
        const tokens = (await response.clone().json()) as Record<
          string,
          unknown
        >;
        if (typeof tokens.access_token !== "string") return response;
        // Save before the lock opens, so the next caller sees the new
        // refresh token. A provider that does not rotate keeps the old one.
        await fenceLock(state, lock, REFRESH_LOCK_TTL_MS);
        await putMcpStoredOAuthCredentials(userId, provider, {
          ...stored,
          tokens: {
            ...current,
            ...tokens,
            refresh_token:
              typeof tokens.refresh_token === "string"
                ? tokens.refresh_token
                : sentRefreshToken,
          } as typeof current,
        });
        return response;
      },
      // Keep the lock while Notion answers: a lost lock after a rotation
      // would drop the new tokens.
      { keepAlive: true, ttlMs: REFRESH_LOCK_TTL_MS, waitMs: REFRESH_WAIT_MS },
    );
    if (!attempt.acquired) {
      throw new Error(
        `Timed out waiting for the ${provider} MCP token refresh`,
      );
    }
    return attempt.value;
  }) as typeof fetch;
}
