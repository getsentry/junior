import { credentialLogContext } from "@/chat/credentials/context";
import type { LogContext } from "@/chat/log-context";
import { logWarn, setSentryUser, withSpan } from "@/chat/logging";
import {
  executeCredentialedEgressRequest,
  type CredentialedEgressHttpInterceptor,
} from "@/chat/egress/credentialed";
import { resolveSandboxEgressProviderForHost } from "@/chat/sandbox/egress/policy";
import {
  parseSandboxEgressCredentialToken,
  SANDBOX_EGRESS_PROXY_PATH,
  type SandboxEgressCredentialContext,
} from "@/chat/sandbox/egress/session";
import {
  shouldPropagateSandboxEgressTrace,
  type SandboxEgressTracePropagationConfig,
} from "@/chat/sandbox/egress/tracing";
import * as Sentry from "@/chat/sentry";

// Module overview: run one sandbox egress request after its sandbox provider
// has caught and authenticated it.
//
// Each sandbox provider owns how it catches sandbox traffic and how it proves
// which sandbox VM sent a request. For example, `vercel.ts` in this folder
// reads Vercel's forwarding headers and OIDC token. The provider then calls
// `executeSandboxEgressRequest` with the VM id, the upstream URL, and the
// signed credential token. This module checks provider ownership and the
// credential context, then hands the request to the shared credentialed egress
// engine.

/**
 * Intercepts a verified sandbox HTTP request before live provider forwarding.
 *
 * The hook runs after the sandbox provider check, provider ownership, and
 * credential-context checks have succeeded.
 */
export type SandboxEgressHttpInterceptor = CredentialedEgressHttpInterceptor;

/** Runtime dependencies for running one verified sandbox egress request. */
export interface SandboxEgressProxyDeps {
  fetch?: typeof fetch;
  interceptHttp?: SandboxEgressHttpInterceptor;
  tracePropagation?: SandboxEgressTracePropagationConfig;
}

/** One sandbox egress request that its sandbox provider has authenticated. */
export interface SandboxEgressRequest {
  /** The request from the sandbox. Its method, headers, and body go upstream. */
  request: Request;
  /** The sandbox VM session id that the provider verified. */
  egressId: string;
  /** The original upstream URL that the sandbox requested. */
  upstreamUrl: URL;
  /** The signed credential token from the sandbox network policy. */
  credentialToken?: string;
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

/** Return log attributes that identify one sandbox egress request. */
export function sandboxEgressAttributes(input: {
  egressId?: string;
  host?: string;
  method?: string;
  path?: string;
  provider?: string;
  status?: number;
}): Record<string, unknown> {
  return {
    ...(input.egressId
      ? { "app.sandbox.egress_id": input.egressId }
      : undefined),
    ...(input.provider ? { "app.provider.name": input.provider } : undefined),
    ...(input.host ? { "server.address": input.host } : undefined),
    ...(input.method ? { "http.request.method": input.method } : undefined),
    ...(input.path ? { "url.path": input.path } : undefined),
    ...(input.status
      ? { "http.response.status_code": input.status }
      : undefined),
  };
}

/** Hide the credential token in a sandbox egress proxy path before logging. */
export function redactSandboxEgressProxyPath(pathname: string): string {
  if (pathname.startsWith(`${SANDBOX_EGRESS_PROXY_PATH}/`)) {
    return `${SANDBOX_EGRESS_PROXY_PATH}/<token>`;
  }
  return pathname;
}

/** Return log attributes for the proxy route and the upstream path. */
export function sandboxEgressRoutingAttributes(
  request: Request,
  upstreamUrl?: URL,
): Record<string, unknown> {
  const proxyUrl = new URL(request.url);
  const attributes: Record<string, unknown> = {
    "app.sandbox.egress.proxy_path": redactSandboxEgressProxyPath(
      proxyUrl.pathname,
    ),
  };
  if (upstreamUrl) {
    attributes["app.sandbox.egress.upstream_path"] = upstreamUrl.pathname;
    const gitService = upstreamUrl.searchParams.get("service");
    if (
      upstreamUrl.hostname.toLowerCase() === "github.com" &&
      (gitService === "git-upload-pack" || gitService === "git-receive-pack")
    ) {
      attributes["app.sandbox.egress.git_service"] = gitService;
    }
  }
  return attributes;
}

/**
 * Name the Conversation and the accountable person from the verified token.
 * Each proxy request is a new HTTP request with no run log context, so the
 * proxy binds the same fields that the run binds.
 */
function sandboxEgressLogContext(
  context: SandboxEgressCredentialContext,
): LogContext {
  return {
    ...(context.conversationId
      ? { conversationId: context.conversationId }
      : undefined),
    ...credentialLogContext(context.credentials),
  };
}

/** Continue inbound trace context only after sandbox egress verification succeeds. */
function continueSandboxEgressTrace<T>(
  request: Request,
  upstreamHost: string,
  tracePropagation: SandboxEgressTracePropagationConfig,
  credentialContext: SandboxEgressCredentialContext,
  callback: () => Promise<T>,
): Promise<T> {
  const sentryTrace = request.headers.get("sentry-trace") ?? undefined;
  const baggage = request.headers.get("baggage") ?? undefined;
  const logContext = sandboxEgressLogContext(credentialContext);
  const run = () =>
    withSpan(
      "sandbox.egress",
      "http.server",
      logContext,
      async () => {
        setSentryUser(
          logContext.userId ? { id: logContext.userId } : undefined,
        );
        return await callback();
      },
      {
        "http.request.method": request.method,
        "url.path": redactSandboxEgressProxyPath(new URL(request.url).pathname),
      },
    );
  if (
    !shouldPropagateSandboxEgressTrace(upstreamHost, tracePropagation) ||
    (!sentryTrace && !baggage)
  ) {
    return run();
  }
  return Sentry.continueTrace({ sentryTrace, baggage }, run);
}

/**
 * Run one sandbox egress request that its sandbox provider authenticated.
 *
 * This is the shared authorization boundary. It rejects upstream hosts that no
 * plugin owns, rejects signed credential contexts that do not match the
 * verified VM id, and only then asks the credentialed egress engine to issue
 * credentials and contact the upstream provider.
 */
export async function executeSandboxEgressRequest(
  input: SandboxEgressRequest,
  deps: SandboxEgressProxyDeps = {},
): Promise<Response> {
  const { request, upstreamUrl } = input;
  const activeEgressId = input.egressId;
  const provider = resolveSandboxEgressProviderForHost(upstreamUrl.hostname);
  if (!provider) {
    logWarn("sandbox.egress.provider.unresolved", {
      ...sandboxEgressAttributes({
        egressId: activeEgressId,
        host: upstreamUrl.hostname,
        method: request.method,
        path: upstreamUrl.pathname,
        status: 403,
      }),
      ...sandboxEgressRoutingAttributes(request, upstreamUrl),
    });
    return jsonError("No provider owns forwarded host", 403);
  }

  // The sandbox provider authenticates the VM session; Junior's signed
  // credential context identifies which provider credentials may be issued
  // lazily for that session.
  const credentialContext = parseSandboxEgressCredentialToken(
    input.credentialToken,
  );
  if (!credentialContext || credentialContext.egressId !== activeEgressId) {
    logWarn("sandbox.egress.credential_context.unauthorized", {
      ...sandboxEgressAttributes({
        egressId: activeEgressId,
        host: upstreamUrl.hostname,
        method: request.method,
        path: upstreamUrl.pathname,
        provider,
        status: 403,
      }),
      ...sandboxEgressRoutingAttributes(request, upstreamUrl),
    });
    return jsonError(
      "Sandbox egress credential context is not authorized",
      403,
    );
  }

  return await continueSandboxEgressTrace(
    request,
    upstreamUrl.hostname,
    deps.tracePropagation ?? {},
    credentialContext,
    async () =>
      await executeCredentialedEgressRequest({
        activeEgressId,
        credentialContext,
        deps,
        provider,
        request,
        upstreamUrl,
      }),
  );
}
