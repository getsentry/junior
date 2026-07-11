const AUTH_SCHEME = /^\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+(?=\s)/;
const BEARER_CHALLENGE = /(?:^|,)\s*Bearer(?:\s|$)/i;
const RESOURCE_METADATA_PARAMETER = /(?:^|[,\s])resource_metadata\s*=/i;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BODY_HEADERS = [
  "content-encoding",
  "content-language",
  "content-location",
  "content-type",
];
const CROSS_ORIGIN_CREDENTIAL_HEADERS = [
  "authorization",
  "cookie",
  "proxy-authorization",
];

function isRedirect(status: number): boolean {
  return REDIRECT_STATUSES.has(status);
}

/** Adapts nonstandard protected-resource challenges without masking scope errors. */
function normalizeProtectedResourceChallenge(response: Response): Response {
  const challenge = response.headers.get("www-authenticate");
  if (
    !challenge ||
    !AUTH_SCHEME.test(challenge) ||
    (response.status !== 302 &&
      (response.status !== 403 || BEARER_CHALLENGE.test(challenge))) ||
    !RESOURCE_METADATA_PARAMETER.test(challenge)
  ) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("www-authenticate", challenge.replace(AUTH_SCHEME, "Bearer"));
  headers.delete("location");
  return new Response(response.body, {
    status: 401,
    headers,
  });
}

/** Continues a captured redirect without replaying the MCP resource request. */
async function followRedirect(
  request: Request,
  response: Response,
  baseFetch: typeof fetch,
): Promise<Response> {
  const location = response.headers.get("location");
  if (!location) {
    return response;
  }

  const redirectUrl = new URL(location, request.url);
  const headers = new Headers(request.headers);
  const becomesGet =
    (response.status === 303 &&
      request.method !== "GET" &&
      request.method !== "HEAD") ||
    ((response.status === 301 || response.status === 302) &&
      request.method === "POST");
  if (becomesGet) {
    for (const header of BODY_HEADERS) {
      headers.delete(header);
    }
  }
  if (redirectUrl.origin !== new URL(request.url).origin) {
    for (const header of CROSS_ORIGIN_CREDENTIAL_HEADERS) {
      headers.delete(header);
    }
  }

  const redirectInit: RequestInit & { duplex?: "half" } = {
    headers,
    method: becomesGet ? "GET" : request.method,
    signal: request.signal,
  };
  if (!becomesGet && request.body) {
    redirectInit.body = await request.arrayBuffer();
    redirectInit.duplex = "half";
  }

  return await baseFetch(redirectUrl, redirectInit);
}

/** Adapts protected-resource OAuth challenges to the MCP SDK contract. */
export function createMcpTransportFetch(
  serverUrl: URL,
  baseFetch: typeof fetch = globalThis.fetch,
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== serverUrl.href) {
      return await baseFetch(input, init);
    }

    const response = await baseFetch(request.clone(), {
      redirect: "manual",
    });
    const normalized = normalizeProtectedResourceChallenge(response);
    if (normalized !== response) {
      return normalized;
    }

    if (isRedirect(response.status)) {
      return await followRedirect(request, response, baseFetch);
    }
    return response;
  };
}
