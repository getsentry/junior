import type {
  SandboxEgressAuthRequiredSignal,
  SandboxEgressPermissionDeniedSignal,
} from "@/chat/sandbox/egress/schemas";

/** Starts the body of the egress proxy's response for a missing credential. */
export const SANDBOX_EGRESS_AUTH_REQUIRED_MARKER = "junior-auth-required";

/** Authenticated transport for signal state owned by another Junior process. */
export interface SandboxEgressSignalTransport {
  clear: (credentialToken: string) => Promise<void>;
  consume: (credentialToken: string) => Promise<{
    authRequired?: SandboxEgressAuthRequiredSignal;
    permissionDenied?: SandboxEgressPermissionDeniedSignal;
  }>;
}
