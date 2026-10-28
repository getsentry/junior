import { http, HttpResponse } from "msw";

export const EVAL_OAUTH_PROVIDER = "eval-oauth";
export const EVAL_OAUTH_CODE = "eval-oauth-code";
export const EVAL_OAUTH_ORIGIN = "https://example.com";
const EVAL_OAUTH_AUTHORIZE_ENDPOINT = `${EVAL_OAUTH_ORIGIN}/junior-eval-oauth/oauth/authorize`;
const EVAL_OAUTH_TOKEN_ENDPOINT = `${EVAL_OAUTH_ORIGIN}/junior-eval-oauth/oauth/token`;
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
  // The person approves at once, and the provider redirects with the code.
  http.get(EVAL_OAUTH_AUTHORIZE_ENDPOINT, ({ request }) => {
    const params = new URL(request.url).searchParams;
    const callback = new URL(params.get("redirect_uri") ?? "");
    callback.searchParams.set("code", EVAL_OAUTH_CODE);
    callback.searchParams.set("state", params.get("state") ?? "");
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
