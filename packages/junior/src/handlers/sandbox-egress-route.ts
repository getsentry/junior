import { ALL as sandboxEgressProxyALL } from "@/handlers/sandbox-egress-proxy";
import { isSandboxEgressRequest } from "@/handlers/sandbox-egress-proxy";

/**
 * Route authenticated sandbox egress proxy traffic before ordinary app routes.
 */
export async function handleSandboxEgressRoute(
  request: Request,
  tracePropagationDomains: string[],
  next: () => Promise<void>,
): Promise<Response | void> {
  if (isSandboxEgressRequest(request)) {
    return await sandboxEgressProxyALL(request, {
      tracePropagation: { domains: tracePropagationDomains },
    });
  }
  await next();
}
