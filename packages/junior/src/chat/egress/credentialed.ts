import {
  credentialAccount,
  credentialAuditAttributes,
} from "@/chat/credentials/audit";
import { isGitReceivePack, readGitPush } from "@/chat/egress/git-push";
import { isGraphqlPost, readGraphqlRequest } from "@/chat/egress/graphql";
import { logAudit, logException, logWarn } from "@/chat/logging";
import { onPluginEgressResponse } from "@/chat/plugins/credential-hooks";
import { matchesSandboxEgressDomain } from "@/chat/sandbox/egress/policy";
import {
  hasSandboxEgressLeaseTransformForHost,
  isWorkloadIdentityProvider,
  sandboxEgressCredentialLease,
  SandboxEgressCredentialError,
  selectSandboxEgressGrant,
  type SandboxEgressGrantSelection,
} from "@/chat/sandbox/egress/credentials";
import { redactSandboxEgressProxyPath } from "@/chat/sandbox/egress/proxy-path";
import { responseTextWithinLimit } from "@/chat/egress/response-text";
import type { SandboxCredentialRequest } from "@/chat/sandbox/egress/credential-request";
import { SANDBOX_EGRESS_AUTH_REQUIRED_MARKER } from "@/chat/sandbox/egress/signals";
import {
  clearSandboxEgressCredentialLease,
  setSandboxEgressPermissionDeniedSignal,
  type SandboxEgressCredentialContext,
  type SandboxEgressCredentialLease,
} from "@/chat/sandbox/egress/session";
import {
  shouldPropagateSandboxEgressTrace,
  type SandboxEgressTracePropagationConfig,
} from "@/chat/sandbox/egress/tracing";
import {
  EgressAuthRequired,
  EgressPolicyDenied,
  pluginAuditAttributesSchema,
} from "@sentry/junior-plugin-api";

// Module overview: own credentialed provider forwarding after a caller has
// authenticated the request source and resolved its provider.
//
// `proxy.ts` first proves that the request came from the expected Vercel
// Sandbox VM and reconstructs the upstream URL from Vercel forwarding headers.
// This module starts after that point: it chooses the provider grant, obtains
// credential header transforms, and forwards the upstream request. It records
// the permission signal that the sandbox command runner consumes afterward, and
// returns a needed credential for the caller to ask for.
//
// Keep this file about the provider request itself. Source authentication and
// forwarded-header parsing belong to callers such as the sandbox proxy; lease
// persistence and auth/permission signal storage stay in their caller-specific
// adapters until a second host/plugin caller needs a different storage surface.

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
const UPSTREAM_TOKEN_REJECTION_STATUS = 401;
const UPSTREAM_PERMISSION_REJECTION_STATUS = 403;
const GRANT_SELECTION_BODY_TEXT_LIMIT_BYTES = 64 * 1024;

/**
 * Intercepts the already-authenticated provider request before live forwarding.
 *
 * Tests use this to inspect the exact upstream request after grant selection
 * and credential header injection, without weakening the proxy verification
 * path that runs before this hook is reached.
 */
export type CredentialedEgressHttpInterceptor = (input: {
  provider: string;
  request: Request;
  upstreamUrl: URL;
}) => Promise<Response | undefined>;

/** Runtime dependencies for the credentialed provider forwarding step. */
export interface CredentialedEgressDeps {
  fetch?: typeof fetch;
  interceptHttp?: CredentialedEgressHttpInterceptor;
  tracePropagation?: SandboxEgressTracePropagationConfig;
}

/** A credential that the request needs and the host could not issue. */
export interface CredentialedEgressAuthRequired {
  authorization?: SandboxEgressCredentialLease["authorization"];
  grant: SandboxEgressCredentialLease["grant"];
  kind: "auth_required" | "unavailable";
  message: string;
  provider: string;
}

/**
 * The response for the caller. `authRequired` is set when the response is a
 * 401 because the request needs a credential. Each caller decides how to ask
 * for it.
 */
export interface CredentialedEgressResult {
  authRequired?: CredentialedEgressAuthRequired;
  response: Response;
}

function authRequiredResult(
  authRequired: CredentialedEgressAuthRequired,
  responseMessage = authRequired.message,
): CredentialedEgressResult {
  return {
    authRequired,
    response: new Response(
      `${SANDBOX_EGRESS_AUTH_REQUIRED_MARKER} provider=${authRequired.provider} grant=${authRequired.grant.name} access=${authRequired.grant.access} 401 unauthorized\n${responseMessage}`,
      {
        status: 401,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        },
      },
    ),
  };
}

function policyDeniedResponse(error: EgressPolicyDenied): Response {
  return Response.json(
    { error: error.message },
    {
      status: 403,
      headers: {
        "cache-control": "no-store",
      },
    },
  );
}

/**
 * Name the egress decision on every outcome event, so one query over
 * `app.egress.policy.decision` gives the full trail for a request.
 */
export function egressDecisionAttributes(
  decision: "allowed" | "denied",
  reason?: string,
): Record<string, string> {
  return reason
    ? {
        "app.egress.policy.decision": decision,
        "app.sandbox.egress.policy.reason": reason,
      }
    : { "app.egress.policy.decision": decision };
}

function egressAttributes(input: {
  egressId?: string;
  grantAccess?: "read" | "write";
  grantName?: string;
  grantReason?: string | undefined;
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
    ...(input.grantName ? { "app.grant.name": input.grantName } : undefined),
    ...(input.grantAccess
      ? { "app.grant.access": input.grantAccess }
      : undefined),
    ...(input.grantReason
      ? { "app.grant.reason": input.grantReason }
      : undefined),
    ...(input.host ? { "server.address": input.host } : undefined),
    ...(input.method ? { "http.request.method": input.method } : undefined),
    ...(input.path ? { "url.path": input.path } : undefined),
    ...(input.status
      ? { "http.response.status_code": input.status }
      : undefined),
  };
}

function routingAttributes(
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

function displayedUpstreamPath(upstreamUrl: URL): string {
  const gitService = upstreamUrl.searchParams.get("service");
  if (
    upstreamUrl.hostname.toLowerCase() === "github.com" &&
    (gitService === "git-upload-pack" || gitService === "git-receive-pack")
  ) {
    return `${upstreamUrl.pathname}?service=${gitService}`;
  }
  return upstreamUrl.pathname;
}

function permissionDeniedMessage(
  provider: string,
  grant: SandboxEgressCredentialLease["grant"],
): string {
  return `${provider} returned HTTP 403 after the runtime injected the ${grant.name} grant. The request was forwarded; this is not a local runtime block.`;
}

function isEgressAuthRequired(error: unknown): error is EgressAuthRequired {
  return (
    error instanceof EgressAuthRequired ||
    (error instanceof Error && error.name === "EgressAuthRequired")
  );
}

function isEgressPolicyDenied(error: unknown): error is EgressPolicyDenied {
  return (
    error instanceof EgressPolicyDenied ||
    (error instanceof Error && error.name === "EgressPolicyDenied")
  );
}

/**
 * Record one forwarded provider request as an audit event, so Sentry keeps
 * reads and writes in production.
 */
function logSandboxEgressUpstreamRequest(input: {
  credentialContext: SandboxEgressCredentialContext;
  egressId: string;
  lease: SandboxEgressCredentialLease;
  provider: string;
  request: Request;
  upstream: Response;
  upstreamUrl: URL;
}): void {
  const { grant } = input.lease;
  logAudit("sandbox.egress.upstream.requested", {
    ...egressAttributes({
      egressId: input.egressId,
      grantAccess: grant.access,
      grantName: grant.name,
      grantReason: grant.reason,
      host: input.upstreamUrl.hostname,
      method: input.request.method,
      path: input.upstreamUrl.pathname,
      provider: input.provider,
      status: input.upstream.status,
    }),
    ...routingAttributes(input.request, input.upstreamUrl),
    ...credentialAuditAttributes(input.credentialContext.source),
    ...grant.auditAttributes,
    "app.credential.account": credentialAccount(
      input.lease,
      input.credentialContext.credentials,
    ),
    ...egressDecisionAttributes("allowed"),
    "app.sandbox.egress.upstream_ok": input.upstream.ok,
  });
}

async function requestBodyBytes(
  request: Request,
): Promise<ArrayBuffer | undefined> {
  if (
    request.method === "GET" ||
    request.method === "HEAD" ||
    request.method === "OPTIONS" ||
    request.body === null
  ) {
    return undefined;
  }
  return await request.arrayBuffer();
}

/**
 * Explain a request body that the runtime delivered already used.
 *
 * The forwarded headers cannot show whether the body was empty, so the proxy
 * does not send a credentialed write upstream without its payload.
 */
function unreadableBodyResponse(eventId: string | undefined): Response {
  return Response.json(
    {
      source: "junior-egress",
      error:
        "The sandbox egress proxy could not read the request body, so it did not send the request upstream.",
      ...(eventId ? { sentryEventId: eventId } : undefined),
    },
    { status: 500, headers: { "cache-control": "no-store" } },
  );
}

/** Identify GitHub review writes whose body decides whether a grant is safe. */
function isGitHubPullRequestReviewPost(input: {
  provider: string;
  requestMethod: string;
  upstreamUrl: URL;
}): boolean {
  return (
    input.provider === "github" &&
    input.requestMethod.toUpperCase() === "POST" &&
    input.upstreamUrl.hostname.toLowerCase() === "api.github.com" &&
    /^\/repos\/[^/]+\/[^/]+\/pulls\/[^/]+\/reviews(?:\/[^/]+\/events)?$/.test(
      input.upstreamUrl.pathname.toLowerCase(),
    )
  );
}

function grantSelectionBodyText(
  body: ArrayBuffer | undefined,
): string | undefined {
  if (body === undefined) {
    return undefined;
  }
  if (body.byteLength > GRANT_SELECTION_BODY_TEXT_LIMIT_BYTES) {
    throw new EgressPolicyDenied(
      "GitHub pull request review request body is too large to inspect before issuing credentials.",
    );
  }
  return new TextDecoder().decode(body);
}

/**
 * Build the upstream request headers.
 *
 * Sandbox/proxy-only headers are stripped so they cannot leak to providers, and
 * trace headers are preserved only for hosts opted into trace propagation.
 * Credential lease transforms win last because they are the host-issued
 * authority for provider auth headers.
 */
function requestHeaders(
  request: Request,
  headerTransforms: SandboxEgressCredentialLease["headerTransforms"],
  upstreamHost: string,
  tracePropagation: SandboxEgressTracePropagationConfig,
): Headers {
  const headers = new Headers();
  const mayPropagateTrace = shouldPropagateSandboxEgressTrace(
    upstreamHost,
    tracePropagation,
  );
  for (const [key, value] of request.headers) {
    const normalized = key.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(normalized) ||
      PROXY_ONLY_HEADERS.has(normalized)
    ) {
      continue;
    }
    if (TRACE_PROPAGATION_HEADERS.has(normalized) && !mayPropagateTrace) {
      continue;
    }
    headers.append(key, value);
  }

  for (const transform of headerTransforms) {
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

function responseHeaders(upstream: Response): Headers {
  const headers = new Headers();
  for (const [key, value] of upstream.headers) {
    const normalized = key.toLowerCase();
    if (
      !HOP_BY_HOP_HEADERS.has(normalized) &&
      !DECODED_RESPONSE_HEADERS.has(normalized)
    ) {
      headers.append(key, value);
    }
  }
  return headers;
}

function leaseLogAttributes(input: {
  egressId: string;
  lease: SandboxEgressCredentialLease;
  provider: string;
  request: Request;
  status: number;
  upstreamUrl: URL;
}): Record<string, unknown> {
  return {
    ...egressAttributes({
      egressId: input.egressId,
      grantAccess: input.lease.grant.access,
      grantName: input.lease.grant.name,
      grantReason: input.lease.grant.reason,
      host: input.upstreamUrl.hostname,
      method: input.request.method,
      path: input.upstreamUrl.pathname,
      provider: input.provider,
      status: input.status,
    }),
    ...routingAttributes(input.request, input.upstreamUrl),
  };
}

async function recordSandboxPermissionDenied(input: {
  credentialContext: SandboxEgressCredentialContext;
  lease: SandboxEgressCredentialLease;
  message: string;
  provider: string;
  upstream: Response;
  upstreamUrl: URL;
}): Promise<void> {
  await setSandboxEgressPermissionDeniedSignal(input.credentialContext, {
    provider: input.provider,
    grant: input.lease.grant,
    ...(input.lease.account ? { account: input.lease.account } : undefined),
    message: input.message,
    source: "upstream",
    status: input.upstream.status,
    upstreamHost: input.upstreamUrl.hostname,
    upstreamPath: displayedUpstreamPath(input.upstreamUrl),
  });
}

async function recordSandboxPolicyDenied(input: {
  credentialContext: SandboxEgressCredentialContext;
  message: string;
  provider: string;
  request: Request;
  upstreamUrl: URL;
}): Promise<void> {
  await setSandboxEgressPermissionDeniedSignal(input.credentialContext, {
    message: input.message,
    method: input.request.method.toUpperCase(),
    provider: input.provider,
    source: "policy",
    upstreamHost: input.upstreamUrl.hostname,
    upstreamPath: displayedUpstreamPath(input.upstreamUrl),
  });
}

/**
 * Forward a request that gets no credential, with its own headers.
 *
 * Proxy-only and hop-by-hop headers are still stripped, and trace headers
 * follow the same propagation rules as credentialed requests.
 */
async function forwardWithoutCredential(input: {
  activeEgressId: string;
  body: ArrayBuffer | undefined;
  credentialContext: SandboxEgressCredentialContext;
  credentialRequest: Exclude<SandboxCredentialRequest, "placeholder">;
  deps: CredentialedEgressDeps;
  provider: string;
  request: Request;
  upstreamUrl: URL;
}): Promise<Response> {
  const { body, deps, provider, request, upstreamUrl } = input;
  const headers = requestHeaders(
    request,
    [],
    upstreamUrl.hostname,
    deps.tracePropagation ?? {},
  );
  const intercepted = await deps.interceptHttp?.({
    provider,
    request: new Request(upstreamUrl, {
      method: request.method,
      headers,
      ...(body !== undefined ? { body } : undefined),
    }),
    upstreamUrl,
  });
  if (intercepted) {
    return intercepted;
  }
  const upstream = await (deps.fetch ?? fetch)(upstreamUrl, {
    method: request.method,
    headers,
    ...(body !== undefined ? { body } : undefined),
    redirect: "manual",
  });
  logAudit("sandbox.egress.upstream.requested", {
    ...egressAttributes({
      egressId: input.activeEgressId,
      host: upstreamUrl.hostname,
      method: request.method,
      path: upstreamUrl.pathname,
      provider,
      status: upstream.status,
    }),
    ...routingAttributes(request, upstreamUrl),
    ...credentialAuditAttributes(input.credentialContext.source),
    ...egressDecisionAttributes("allowed"),
    "app.sandbox.egress.credential_request": input.credentialRequest,
    "app.sandbox.egress.upstream_ok": upstream.ok,
  });
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders(upstream),
  });
}

/**
 * Forward one verified sandbox egress request with host-managed credentials.
 *
 * The caller must already have authenticated the sandbox VM, checked the signed
 * credential context, and resolved the provider for `upstreamUrl`. This function
 * then selects the read/write grant, issues or reuses a short-lived credential
 * lease, and applies its header transforms. A provider auth failure becomes a
 * 401 response and `authRequired`, not raw upstream details for the agent.
 */
export async function executeCredentialedEgressRequest(input: {
  activeEgressId: string;
  credentialContext: SandboxEgressCredentialContext;
  deps: CredentialedEgressDeps;
  operation?: string;
  provider: string;
  request: Request;
  upstreamUrl: URL;
  /** Use only the credential subject's own stored OAuth token. */
  userOAuthOnly?: boolean;
  /**
   * Forward the request without a credential, because it carries its own
   * or asks for none. The plugin's egress policy still applies.
   */
  withoutCredential?: Exclude<SandboxCredentialRequest, "placeholder">;
}): Promise<CredentialedEgressResult> {
  const {
    activeEgressId,
    credentialContext,
    deps,
    operation,
    provider,
    request,
    upstreamUrl,
  } = input;
  let body: ArrayBuffer | undefined;
  try {
    body = await requestBodyBytes(request);
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }
    return {
      response: unreadableBodyResponse(
        logException(error, "sandbox.egress.request_body.unreadable", {
          ...egressAttributes({
            egressId: activeEgressId,
            host: upstreamUrl.hostname,
            method: request.method,
            path: upstreamUrl.pathname,
            provider,
            status: 500,
          }),
          ...routingAttributes(request, upstreamUrl),
          ...credentialAuditAttributes(credentialContext.source),
          ...egressDecisionAttributes("denied", "request body is unreadable"),
        }),
      ),
    };
  }
  let grantSelection: SandboxEgressGrantSelection;
  try {
    grantSelection = await selectSandboxEgressGrant({
      actor: credentialContext.credentials.actor,
      ...(isGitHubPullRequestReviewPost({
        provider,
        requestMethod: request.method,
        upstreamUrl,
      })
        ? { bodyText: grantSelectionBodyText(body) }
        : undefined),
      ...(isGitReceivePack(request.method, upstreamUrl)
        ? { gitPush: readGitPush(body) }
        : undefined),
      ...(isGraphqlPost(request.method, upstreamUrl)
        ? { graphql: await readGraphqlRequest(body) }
        : undefined),
      ...(operation ? { operation } : undefined),
      ...(input.userOAuthOnly ? { userOAuthOnly: true } : undefined),
      ...(input.withoutCredential ? { withoutCredential: true } : undefined),
      provider,
      method: request.method,
      upstreamUrl,
    });
  } catch (error) {
    if (isEgressPolicyDenied(error)) {
      logWarn("sandbox.egress.policy.denied", {
        ...egressAttributes({
          egressId: activeEgressId,
          host: upstreamUrl.hostname,
          method: request.method,
          path: upstreamUrl.pathname,
          provider,
          status: 403,
        }),
        ...routingAttributes(request, upstreamUrl),
        ...credentialAuditAttributes(credentialContext.source),
        ...pluginAuditAttributesSchema.safeParse(error.auditAttributes).data,
        ...egressDecisionAttributes("denied", error.message),
      });
      // Sandbox commands read this signal. Host plugin tools read the 403.
      await recordSandboxPolicyDenied({
        credentialContext,
        message: error.message,
        provider,
        request,
        upstreamUrl,
      });
      return { response: policyDeniedResponse(error) };
    }
    throw error;
  }
  if (input.withoutCredential) {
    return {
      response: await forwardWithoutCredential({
        activeEgressId,
        body,
        credentialContext,
        credentialRequest: input.withoutCredential,
        deps,
        provider,
        request,
        upstreamUrl,
      }),
    };
  }
  async function resolveLease(): Promise<
    SandboxEgressCredentialLease | CredentialedEgressResult
  > {
    try {
      return await sandboxEgressCredentialLease(
        provider,
        grantSelection,
        credentialContext,
        operation,
      );
    } catch (error) {
      if (!(error instanceof SandboxEgressCredentialError)) {
        throw error;
      }
      const isAuthRequired = error.kind === "auth_required";
      logWarn(
        isAuthRequired
          ? "sandbox.egress.credential.needed"
          : "sandbox.egress.credential.unavailable",
        {
          ...egressAttributes({
            egressId: activeEgressId,
            grantAccess: error.grant.access,
            grantName: error.grant.name,
            grantReason: error.grant.reason,
            host: upstreamUrl.hostname,
            method: request.method,
            path: upstreamUrl.pathname,
            provider: error.provider,
            status: 401,
          }),
          ...routingAttributes(request, upstreamUrl),
          ...credentialAuditAttributes(credentialContext.source),
          ...egressDecisionAttributes("denied", error.message),
        },
      );
      return authRequiredResult({
        ...(error.authorization
          ? { authorization: error.authorization }
          : undefined),
        grant: error.grant,
        kind: error.kind,
        message: error.message,
        provider: error.provider,
      });
    }
  }

  let leased = await resolveLease();
  if ("response" in leased) {
    return leased;
  }
  let lease = leased;

  const attributes = (
    activeLease: SandboxEgressCredentialLease,
    status: number,
  ) =>
    leaseLogAttributes({
      egressId: activeEgressId,
      lease: activeLease,
      provider,
      request,
      status,
      upstreamUrl,
    });

  if (!hasSandboxEgressLeaseTransformForHost(lease, upstreamUrl.hostname)) {
    logWarn("sandbox.egress.transform.missing", {
      ...attributes(lease, 403),
      ...credentialAuditAttributes(credentialContext.source),
      ...egressDecisionAttributes(
        "denied",
        "credential lease does not cover forwarded host",
      ),
      "app.sandbox.egress.transform_domains": lease.headerTransforms.map(
        (transform) => transform.domain,
      ),
    });
    return {
      response: Response.json(
        { error: "Credential lease does not cover forwarded host" },
        { status: 403 },
      ),
    };
  }

  const fetchImpl = deps.fetch ?? fetch;
  // One retry after upstream 403: clear/replace the cached lease, then try again.
  let retriedAfter403 = false;

  /* oxlint-disable no-await-in-loop -- The loop sends the request again only after a 403, and each step waits on the step before. */
  while (true) {
    const headers = requestHeaders(
      request,
      lease.headerTransforms,
      upstreamUrl.hostname,
      deps.tracePropagation ?? {},
    );
    const intercepted = await deps.interceptHttp?.({
      provider,
      request: new Request(upstreamUrl, {
        method: request.method,
        headers,
        ...(body !== undefined ? { body } : undefined),
      }),
      upstreamUrl,
    });
    if (intercepted) {
      return { response: intercepted };
    }

    const requestBody = body instanceof ArrayBuffer ? body.slice(0) : body;
    const upstream = await fetchImpl(upstreamUrl, {
      method: request.method,
      headers,
      ...(requestBody !== undefined ? { body: requestBody } : undefined),
      redirect: "manual",
    });
    let pluginPermissionDenied: { message: string } | undefined;
    try {
      const effects = await onPluginEgressResponse({
        provider,
        grant: lease.grant,
        method: request.method,
        ...(operation ? { operation } : undefined),
        upstreamUrl,
        response: {
          headers: new Headers(upstream.headers),
          readText: async (maxBytes) =>
            await responseTextWithinLimit(upstream, maxBytes),
          status: upstream.status,
        },
      });
      pluginPermissionDenied = effects.permissionDenied;
    } catch (error) {
      if (!isEgressAuthRequired(error)) {
        throw error;
      }
      await clearSandboxEgressCredentialLease(
        provider,
        lease.grant,
        credentialContext,
      );
      logWarn("sandbox.egress.upstream_auth_requirement.classified", {
        ...attributes(lease, upstream.status),
      });
      await upstream.body?.cancel().catch(() => undefined);
      const authorization = error.authorization ?? lease.authorization;
      return authRequiredResult({
        ...(authorization ? { authorization } : undefined),
        grant: lease.grant,
        kind: "auth_required",
        message: error.message,
        provider,
      });
    }
    logSandboxEgressUpstreamRequest({
      credentialContext,
      egressId: activeEgressId,
      lease,
      provider,
      request,
      upstream,
      upstreamUrl,
    });
    if (upstream.status >= 400) {
      logWarn("sandbox.egress.upstream_response.failed", {
        ...attributes(lease, upstream.status),
        "error.type": `http_${upstream.status}`,
      });
    }
    // A workload identity token always acts as the same service account or
    // app, so a new token cannot fix an HTTP 403. Apps and Google APIs also
    // use 403 for resource access and quota errors, so egress forwards the
    // 403 body and keeps the shared lease.
    const workloadIdentity = isWorkloadIdentityProvider(provider);
    if (
      upstream.status === UPSTREAM_TOKEN_REJECTION_STATUS &&
      workloadIdentity
    ) {
      // A federated bot credential has no account that a person can connect,
      // so report it as unavailable instead of starting an auth flow.
      const message = `Upstream rejected the ${provider} workload identity credential with HTTP ${upstream.status}.`;
      logWarn("sandbox.egress.upstream_auth.rejected", {
        ...attributes(lease, upstream.status),
      });
      await clearSandboxEgressCredentialLease(
        provider,
        lease.grant,
        credentialContext,
      );
      await upstream.body?.cancel().catch(() => undefined);
      return authRequiredResult(
        {
          grant: lease.grant,
          kind: "unavailable",
          message,
          provider,
        },
        `${message}\n`,
      );
    }
    if (upstream.status === UPSTREAM_TOKEN_REJECTION_STATUS) {
      logWarn("sandbox.egress.upstream_auth.rejected", {
        ...attributes(lease, upstream.status),
        "app.sandbox.egress.www_authenticate":
          upstream.headers.get("www-authenticate") ?? undefined,
      });
      await clearSandboxEgressCredentialLease(
        provider,
        lease.grant,
        credentialContext,
      );
      await upstream.body?.cancel().catch(() => undefined);
      const message = `Provider rejected the injected ${provider} credential.`;
      return authRequiredResult(
        {
          ...(lease.authorization
            ? { authorization: lease.authorization }
            : undefined),
          grant: lease.grant,
          kind: "auth_required",
          message,
          provider,
        },
        `${message}\n`,
      );
    }
    if (
      upstream.status === UPSTREAM_PERMISSION_REJECTION_STATUS &&
      !retriedAfter403 &&
      !workloadIdentity
    ) {
      logWarn("sandbox.egress.upstream_auth.rejected", {
        ...attributes(lease, upstream.status),
      });
      await clearSandboxEgressCredentialLease(
        provider,
        lease.grant,
        credentialContext,
      );
      await upstream.body?.cancel().catch(() => undefined);
      logWarn("sandbox.egress.upstream_auth.retrying", {
        ...attributes(lease, upstream.status),
      });
      leased = await resolveLease();
      if ("response" in leased) {
        return leased;
      }
      lease = leased;
      retriedAfter403 = true;
      continue;
    }
    if (upstream.status === UPSTREAM_PERMISSION_REJECTION_STATUS) {
      logWarn("sandbox.egress.upstream_auth.rejected", {
        ...attributes(lease, upstream.status),
      });
      if (!workloadIdentity) {
        await clearSandboxEgressCredentialLease(
          provider,
          lease.grant,
          credentialContext,
        );
      }
      await recordSandboxPermissionDenied({
        credentialContext,
        provider,
        lease,
        message:
          pluginPermissionDenied?.message ??
          permissionDeniedMessage(provider, lease.grant),
        upstream,
        upstreamUrl,
      });
      if (pluginPermissionDenied) {
        logWarn("sandbox.egress.upstream_permission.classified", {
          ...attributes(lease, upstream.status),
        });
      }
      return {
        response: new Response(upstream.body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: responseHeaders(upstream),
        }),
      };
    }

    if (pluginPermissionDenied) {
      await recordSandboxPermissionDenied({
        credentialContext,
        provider,
        lease,
        message: pluginPermissionDenied.message,
        upstream,
        upstreamUrl,
      });
      logWarn("sandbox.egress.upstream_permission.classified", {
        ...attributes(lease, upstream.status),
      });
    }

    return {
      response: new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders(upstream),
      }),
    };
  }
  /* oxlint-enable no-await-in-loop */
}
