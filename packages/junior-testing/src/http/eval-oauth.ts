const EVAL_OAUTH_HOST = "example.com";
const EVAL_OAUTH_PATH_PREFIX = "/junior-eval-oauth";
const EVAL_OAUTH_ACCESS_TOKEN = "eval-oauth-access-token";

/** Intercept eval OAuth fixture HTTP traffic for test scenarios. */
export async function interceptTestEvalOauthHttp(input: {
  provider: string;
  request: Request;
  upstreamUrl: URL;
}): Promise<Response | undefined> {
  if (
    input.provider !== "eval-oauth" ||
    input.upstreamUrl.hostname !== EVAL_OAUTH_HOST
  ) {
    return undefined;
  }

  if (
    input.upstreamUrl.pathname === `${EVAL_OAUTH_PATH_PREFIX}/whoami` &&
    input.request.method === "GET"
  ) {
    const authorization = input.request.headers.get("authorization") ?? "";
    if (authorization !== `Bearer ${EVAL_OAUTH_ACCESS_TOKEN}`) {
      return new Response("missing authorization\n", {
        status: 401,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return new Response("eval-oauth-user\n", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  return new Response(
    `Missing eval OAuth HTTP fixture for ${input.request.method} ${input.upstreamUrl.pathname}\n`,
    {
      status: 501,
      headers: { "content-type": "text/plain; charset=utf-8" },
    },
  );
}
