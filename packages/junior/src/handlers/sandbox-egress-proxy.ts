import {
  isSandboxEgressForwardedRequest,
  proxySandboxEgressRequest,
} from "@/chat/sandbox/egress-proxy";

/** Handles Vercel Sandbox firewall egress proxy requests. */
export async function ALL(request: Request): Promise<Response> {
  return await proxySandboxEgressRequest(request);
}

/** Return whether a request should be routed through sandbox egress proxying. */
export function isSandboxEgressRequest(request: Request): boolean {
  return isSandboxEgressForwardedRequest(request);
}
