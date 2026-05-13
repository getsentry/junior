import { proxySandboxEgressRequest } from "@/chat/sandbox/egress-proxy";

/** Handles Vercel Sandbox firewall egress proxy requests. */
export async function ALL(
  request: Request,
  sandboxId: string,
): Promise<Response> {
  return await proxySandboxEgressRequest(request, sandboxId);
}
