const MAX_OAUTH_ERROR_BODY_BYTES = 16 * 1024;

export type OAuthProviderErrorPhase = "token_exchange" | "token_refresh";

export interface OAuthProviderErrorDetails {
  phase: OAuthProviderErrorPhase;
  provider: string;
  resourceHost: string;
  status?: number;
}

/** Safe failure at a generic OAuth provider boundary. */
export class OAuthProviderError extends Error {
  readonly phase: OAuthProviderErrorPhase;
  readonly provider: string;
  readonly resourceHost: string;
  readonly status?: number;

  constructor(details: OAuthProviderErrorDetails) {
    super(`OAuth provider ${details.phase.replace("_", " ")} failed`);
    this.name = "OAuthProviderError";
    this.phase = details.phase;
    this.provider = details.provider;
    this.resourceHost = details.resourceHost;
    this.status = details.status;
  }
}

/** Return safe generic OAuth provider fields for logs and spans. */
export function getOAuthProviderErrorAttributes(
  error: unknown,
): Record<string, string | number> {
  if (!(error instanceof OAuthProviderError)) {
    return {};
  }
  return {
    "app.credential.provider": error.provider,
    "app.oauth.error.phase": error.phase,
    "server.address": error.resourceHost,
    ...(error.status !== undefined
      ? { "http.response.status_code": error.status }
      : {}),
  };
}

/** Read only the bounded prefix needed to classify an OAuth error response. */
export async function readBoundedOAuthErrorBody(
  response: Response,
): Promise<string> {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";

  try {
    while (bytesRead < MAX_OAUTH_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) {
        return text + decoder.decode();
      }

      const remaining = MAX_OAUTH_ERROR_BODY_BYTES - bytesRead;
      const chunk = value.subarray(0, remaining);
      bytesRead += chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });

      if (chunk.byteLength < value.byteLength) {
        await reader.cancel();
        return text + decoder.decode();
      }
    }

    await reader.cancel();
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

/** Preserve small OAuth error responses while bounding bodies before SDK parsing. */
export function fetchWithBoundedOAuthErrorBodies(
  fetchFn: typeof fetch = globalThis.fetch,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetchFn(input, init);
    if (response.ok || !response.body) {
      return response;
    }

    let body = "";
    try {
      body = await readBoundedOAuthErrorBody(response);
    } catch {
      // Preserve status handling without exposing an unreadable provider body.
      await response.body.cancel().catch(() => undefined);
    }
    return new Response(body, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  }) as typeof fetch;
}
