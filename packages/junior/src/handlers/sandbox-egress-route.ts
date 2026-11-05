import { ALL as sandboxEgressProxyALL } from "@/handlers/sandbox-egress-proxy";
import { isSandboxEgressRequest } from "@/handlers/sandbox-egress-proxy";
import { nameRequestRoute } from "@/chat/sentry-route-name";
import { SANDBOX_EGRESS_PROXY_PATH } from "@/chat/sandbox/egress/session";

// The path segment after the proxy path is a signed credential token.
const SANDBOX_EGRESS_ROUTE = `${SANDBOX_EGRESS_PROXY_PATH}/:token/*`;

/**
 * Route authenticated sandbox egress proxy traffic before ordinary app routes.
 */
export async function handleSandboxEgressRoute(
  request: Request,
  tracePropagationDomains: string[],
  next: () => Promise<void>,
): Promise<Response | void> {
  if (isSandboxEgressRequest(request)) {
    nameRequestRoute(request.method, SANDBOX_EGRESS_ROUTE);
    return await sandboxEgressProxyALL(request, {
      tracePropagation: { domains: tracePropagationDomains },
    });
  }
  await next();
}
