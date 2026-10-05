import { http, HttpResponse } from "msw";

export const EVAL_OAUTH_PROVIDER = "eval-oauth";
export const EVAL_OAUTH_CODE = "eval-oauth-code";
export const EVAL_OAUTH_ORIGIN = "https://example.com";
const EVAL_OAUTH_AUTHORIZE_ENDPOINT = `${EVAL_OAUTH_ORIGIN}/junior-eval-oauth/oauth/authorize`;
const EVAL_OAUTH_TOKEN_ENDPOINT = `${EVAL_OAUTH_ORIGIN}/junior-eval-oauth/oauth/token`;
const EVAL_OAUTH_CLIENT_ID = "eval-oauth-client-id";
const EVAL_OAUTH_ACCESS_TOKEN = "eval-oauth-access-token";
const EVAL_OAUTH_REFRESH_TOKEN = "eval-oauth-refresh-token";
const refreshTokens: string[] = [];

/** Clear captured eval OAuth refresh requests between scenarios. */
export function resetEvalOAuthMockState(): void {
  refreshTokens.length = 0;
}

/** Return refresh tokens submitted to the eval OAuth token endpoint. */
export function readEvalOAuthRefreshTokens(): string[] {
  return [...refreshTokens];
}

export const evalOAuthHandlers = [
  // The person approves at once. The provider sends their browser back to
  // Junior with the code.
  http.get(EVAL_OAUTH_AUTHORIZE_ENDPOINT, ({ request }) => {
    const url = new URL(request.url);
    const redirectUri = url.searchParams.get("redirect_uri");
    const state = url.searchParams.get("state");
    if (
      url.searchParams.get("client_id") !== EVAL_OAUTH_CLIENT_ID ||
      url.searchParams.get("response_type") !== "code" ||
      !redirectUri ||
      !state
    ) {
      return HttpResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    const callback = new URL(redirectUri);
    callback.searchParams.set("code", EVAL_OAUTH_CODE);
    callback.searchParams.set("state", state);
    return new HttpResponse(null, {
      status: 302,
      headers: { Location: callback.toString() },
    });
  }),
  http.post(EVAL_OAUTH_TOKEN_ENDPOINT, async ({ request }) => {
    const bodyText = await request.text();
    const params = new URLSearchParams(bodyText);
    if (params.get("grant_type") === "refresh_token") {
      const refreshToken = params.get("refresh_token") ?? "";
      refreshTokens.push(refreshToken);
      if (refreshToken !== EVAL_OAUTH_REFRESH_TOKEN) {
        return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
      }
      return HttpResponse.json({
        access_token: EVAL_OAUTH_ACCESS_TOKEN,
        token_type: "Bearer",
        expires_in: 3600,
        scope: "read",
      });
    }

    const code = params.get("code");
    if (code !== EVAL_OAUTH_CODE) {
      return HttpResponse.json(
        {
          error: "invalid_grant",
          error_description: `Unexpected code: ${code ?? "<missing>"}`,
        },
        { status: 400 },
      );
    }

    return HttpResponse.json({
      access_token: EVAL_OAUTH_ACCESS_TOKEN,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: EVAL_OAUTH_REFRESH_TOKEN,
      scope: "read",
    });
  }),
];
