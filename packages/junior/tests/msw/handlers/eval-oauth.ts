import { http, HttpResponse } from "msw";

export const EVAL_OAUTH_PROVIDER = "eval-oauth";
export const EVAL_OAUTH_CODE = "eval-oauth-code";
export const EVAL_OAUTH_ORIGIN = "https://eval-oauth.example.test";
const EVAL_OAUTH_TOKEN_ENDPOINT = `${EVAL_OAUTH_ORIGIN}/oauth/token`;
const EVAL_OAUTH_ACCESS_TOKEN = "eval-oauth-access-token";

export function resetEvalOAuthMockState(): void {}

export const evalOAuthHandlers = [
  http.post(EVAL_OAUTH_TOKEN_ENDPOINT, async ({ request }) => {
    const bodyText = await request.text();
    const params = new URLSearchParams(bodyText);
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
      refresh_token: "eval-oauth-refresh-token",
      scope: "read",
    });
  }),
];
