import type {
  SandboxEgressAuthRequiredSignal,
  SandboxEgressPermissionDeniedSignal,
} from "@/chat/sandbox/egress/schemas";

/** Authenticated transport for signal state owned by another Junior process. */
export interface SandboxEgressSignalTransport {
  clear: (credentialToken: string) => Promise<void>;
  consume: (credentialToken: string) => Promise<{
    authRequired?: SandboxEgressAuthRequiredSignal;
    permissionDenied?: SandboxEgressPermissionDeniedSignal;
  }>;
}
