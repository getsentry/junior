import { matchesSandboxEgressDomain } from "@/chat/sandbox/egress/policy";
import type { SandboxEgressCredentialLease } from "@/chat/sandbox/egress/session";
import {
  shouldPropagateSandboxEgressTrace,
  type SandboxEgressTracePropagationConfig,
} from "@/chat/sandbox/egress/tracing";

// Module overview: build the headers for a forwarded provider request and its
// response. Callers decide whether a credential lease applies.

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const PROXY_ONLY_HEADERS = new Set([
  "vercel-sandbox-oidc-token",
  "vercel-forwarded-host",
  "vercel-forwarded-scheme",
  "vercel-forwarded-port",
  "vercel-forwarded-path",
]);
const TRACE_PROPAGATION_HEADERS = new Set([
  "baggage",
  "sentry-trace",
  "traceparent",
]);
const DECODED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
]);

/**
 * Build the upstream request headers.
 *
 * Sandbox/proxy-only headers are stripped so they cannot leak to providers, and
 * trace headers are preserved only for hosts opted into trace propagation.
 * Credential lease transforms win last because they are the host-issued
 * authority for provider auth headers.
 */
export function egressRequestHeaders(
  request: Request,
  lease: SandboxEgressCredentialLease | undefined,
  upstreamHost: string,
  tracePropagation: SandboxEgressTracePropagationConfig,
): Headers {
  const headers = new Headers();
  const mayPropagateTrace = shouldPropagateSandboxEgressTrace(
    upstreamHost,
    tracePropagation,
  );
  request.headers.forEach((value, key) => {
    const normalized = key.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(normalized) ||
      PROXY_ONLY_HEADERS.has(normalized)
    ) {
      return;
    }
    if (TRACE_PROPAGATION_HEADERS.has(normalized) && !mayPropagateTrace) {
      return;
    }
    headers.append(key, value);
  });

  for (const transform of lease?.headerTransforms ?? []) {
    if (!matchesSandboxEgressDomain(upstreamHost, transform.domain)) {
      continue;
    }
    for (const [key, value] of Object.entries(transform.headers)) {
      if (
        TRACE_PROPAGATION_HEADERS.has(key.toLowerCase()) &&
        !mayPropagateTrace
      ) {
        continue;
      }
      headers.set(key, value);
    }
  }
  return headers;
}

/** Copy upstream response headers that are safe to return to the sandbox. */
export function egressResponseHeaders(upstream: Response): Headers {
  const headers = new Headers();
  upstream.headers.forEach((value, key) => {
    const normalized = key.toLowerCase();
    if (
      !HOP_BY_HOP_HEADERS.has(normalized) &&
      !DECODED_RESPONSE_HEADERS.has(normalized)
    ) {
      headers.append(key, value);
    }
  });
  return headers;
}
