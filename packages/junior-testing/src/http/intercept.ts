import { interceptTestEvalOauthHttp } from "./eval-oauth";
import { interceptTestGitHubHttp } from "./github";
import { interceptTestSentryHttp } from "./sentry";

/** Provider-neutral HTTP request passed by transports that can intercept external calls. */
export interface HttpInterceptRequest {
  provider: string;
  request: Request;
  upstreamUrl: URL;
}

function unhandledResponse(input: HttpInterceptRequest): Response {
  return new Response(
    `[HTTP MOCK] Unhandled external request: ${input.request.method} ${input.upstreamUrl.toString()}\n`,
    {
      status: 599,
      headers: { "content-type": "text/plain; charset=utf-8" },
    },
  );
}

const TEST_HTTP_FIXTURES = [
  interceptTestGitHubHttp,
  interceptTestSentryHttp,
  interceptTestEvalOauthHttp,
];

/** Intercept test-owned external HTTP traffic before live network forwarding. */
export async function interceptTestHttp(
  input: HttpInterceptRequest,
): Promise<Response> {
  for (const fixture of TEST_HTTP_FIXTURES) {
    const response = await fixture(input);
    if (response) return response;
  }

  return unhandledResponse(input);
}
