import { sandboxEgressSignalsResponseSchema } from "@/chat/sandbox/egress/schemas";
import type { SandboxEgressSignalTransport } from "@/chat/sandbox/egress/signals";

const SANDBOX_EGRESS_SIGNALS_PATH = "/api/internal/sandbox-egress/signals";

function signalRequest(
  baseUrl: string,
  credentialToken: string,
): { headers: HeadersInit; url: string } {
  return {
    headers: {
      "x-junior-sandbox-egress-token": credentialToken,
    },
    url: `${baseUrl}${SANDBOX_EGRESS_SIGNALS_PATH}`,
  };
}

/** Create authenticated sandbox egress signal transport to the loopback dev server. */
export function createLocalSandboxEgressSignalTransport(
  baseUrl: string,
): SandboxEgressSignalTransport {
  return {
    clear: async (credentialToken) => {
      const request = signalRequest(baseUrl, credentialToken);
      const response = await fetch(request.url, {
        headers: request.headers,
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error(
          `Could not clear dev-server sandbox egress signals: HTTP ${response.status}`,
        );
      }
    },
    consume: async (credentialToken) => {
      const request = signalRequest(baseUrl, credentialToken);
      const response = await fetch(request.url, {
        headers: request.headers,
      });
      if (!response.ok) {
        throw new Error(
          `Could not consume dev-server sandbox egress signals: HTTP ${response.status}`,
        );
      }
      const value = sandboxEgressSignalsResponseSchema.safeParse(
        await response.json(),
      );
      if (!value.success) {
        throw new Error("Dev-server sandbox egress signals were invalid");
      }
      const authRequired = value.data.auth_required;
      const permissionDenied = value.data.permission_denied;
      return {
        ...(authRequired ? { authRequired } : {}),
        ...(permissionDenied ? { permissionDenied } : {}),
      };
    },
  };
}
