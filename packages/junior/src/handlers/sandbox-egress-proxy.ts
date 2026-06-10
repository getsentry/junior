import {
  isSandboxEgressForwardedRequest,
  proxySandboxEgressRequest,
  type SandboxEgressHttpInterceptor,
} from "@/chat/sandbox/egress-proxy";
import type { SandboxEgressTracePropagationConfig } from "@/chat/sandbox/egress-tracing";

interface SandboxEgressProxyOptions {
  interceptHttp?: SandboxEgressHttpInterceptor;
  tracePropagation?: SandboxEgressTracePropagationConfig;
}

/** Handles Vercel Sandbox firewall egress proxy requests. */
export async function ALL(
  request: Request,
  options: SandboxEgressProxyOptions = {},
): Promise<Response> {
  return await proxySandboxEgressRequest(request, {
    interceptHttp: options.interceptHttp,
    tracePropagation: options.tracePropagation,
  });
}

/** Return whether a request should be routed through sandbox egress proxying. */
export function isSandboxEgressRequest(request: Request): boolean {
  return isSandboxEgressForwardedRequest(request);
}
