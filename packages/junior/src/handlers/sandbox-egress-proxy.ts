import { proxySandboxEgressRequest } from "@/chat/sandbox/egress-proxy";

/** Handles Vercel Sandbox firewall egress proxy requests. */
export async function ALL(
  request: Request,
  egressId: string,
): Promise<Response> {
  return await proxySandboxEgressRequest(request, egressId);
}
