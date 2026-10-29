import type { SandboxEgressHttpInterceptor } from "@/chat/sandbox/egress/proxy";
import {
  isVercelSandboxEgressRequest,
  proxyVercelSandboxEgressRequest,
} from "@/chat/sandbox/egress/vercel";
import type { SandboxEgressTracePropagationConfig } from "@/chat/sandbox/egress/tracing";
import type { JWTPayload } from "jose";

/** Options of the sandbox egress proxy handler. */
export interface SandboxEgressProxyOptions {
  interceptHttp?: SandboxEgressHttpInterceptor;
  tracePropagation?: SandboxEgressTracePropagationConfig;
  /** Replace the Vercel OIDC check, for example to check with another clock. */
  verifyOidc?: (token: string) => Promise<JWTPayload>;
}

/** Handles Vercel Sandbox firewall egress proxy requests. */
export async function ALL(
  request: Request,
  options: SandboxEgressProxyOptions = {},
): Promise<Response> {
  return await proxyVercelSandboxEgressRequest(request, {
    interceptHttp: options.interceptHttp,
    tracePropagation: options.tracePropagation,
    verifyOidc: options.verifyOidc,
  });
}

/** Return whether a request should be routed through sandbox egress proxying. */
export function isSandboxEgressRequest(request: Request): boolean {
  return isVercelSandboxEgressRequest(request);
}
