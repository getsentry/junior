const MAX_OAUTH_ERROR_BODY_BYTES = 16 * 1024;
const MAX_OAUTH_ERROR_BODY_READS = MAX_OAUTH_ERROR_BODY_BYTES;
const MAX_OAUTH_ERROR_BODY_READ_MS = 5_000;
const OAUTH_ERROR_BODY_READ_TIMEOUT = Symbol("oauth-error-body-read-timeout");

async function readOAuthErrorBodyChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutResult = new Promise<typeof OAUTH_ERROR_BODY_READ_TIMEOUT>(
    (resolve) => {
      timeout = setTimeout(
        resolve,
        MAX_OAUTH_ERROR_BODY_READ_MS,
        OAUTH_ERROR_BODY_READ_TIMEOUT,
      );
    },
  );
  try {
    const result = await Promise.race([reader.read(), timeoutResult]);
    if (result === OAUTH_ERROR_BODY_READ_TIMEOUT) {
      await reader.cancel();
      throw new Error("OAuth error body read timed out");
    }
    return result;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

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
      : undefined),
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
  let reads = 0;
  let text = "";

  try {
    while (
      bytesRead < MAX_OAUTH_ERROR_BODY_BYTES &&
      reads < MAX_OAUTH_ERROR_BODY_READS
    ) {
      reads += 1;
      const { done, value } = await readOAuthErrorBodyChunk(reader);
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
  onErrorResponseStatus?: (status: number) => void,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetchFn(input, init);
    if (response.ok) {
      return response;
    }

    onErrorResponseStatus?.(response.status);
    if (!response.body) {
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
