import { sandboxEgressSignalsResponseSchema } from "@/chat/sandbox/egress/schemas";
import type { SandboxEgressSignalTransport } from "@/chat/sandbox/egress/signals";

const SANDBOX_EGRESS_SIGNALS_PATH = "/api/internal/sandbox-egress/signals";
const LOCAL_DEV_SERVER_TIMEOUT_MS = 1_000;

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

async function requestLocalDevServer(
  request: ReturnType<typeof signalRequest>,
  init?: RequestInit,
): Promise<Response | undefined> {
  try {
    return await fetch(request.url, {
      ...init,
      headers: request.headers,
      signal: AbortSignal.timeout(LOCAL_DEV_SERVER_TIMEOUT_MS),
    });
  } catch {
    // Ordinary sandbox commands do not require the dev server. The next
    // command probes again, so a later OAuth signal still uses its owner.
    return undefined;
  }
}

/** Create authenticated sandbox egress signal transport to the loopback dev server. */
export function createLocalSandboxEgressSignalTransport(
  baseUrl: string,
): SandboxEgressSignalTransport {
  return {
    clear: async (credentialToken) => {
      const request = signalRequest(baseUrl, credentialToken);
      const response = await requestLocalDevServer(request, {
        method: "DELETE",
      });
      if (!response) {
        return;
      }
      if (!response.ok) {
        throw new Error(
          `Could not clear dev-server sandbox egress signals: HTTP ${response.status}`,
        );
      }
    },
    consume: async (credentialToken) => {
      const request = signalRequest(baseUrl, credentialToken);
      const response = await requestLocalDevServer(request);
      if (!response) {
        return {};
      }
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
        ...(authRequired ? { authRequired } : undefined),
        ...(permissionDenied ? { permissionDenied } : undefined),
      };
    },
  };
}
