import { SANDBOX_WORKSPACE_ROOT } from "@/chat/sandbox/paths";

export const COMMAND_PROXY_ACTIVATE_PREFIX = "JUNIOR_COMMAND_PROXY_ACTIVATE ";
export const COMMAND_PROXY_ACK_DIR = `${SANDBOX_WORKSPACE_ROOT}/.junior/run/command-proxy`;
export const COMMAND_PROXY_ACTIVATION_TIMEOUT_MS = 30_000;

export interface CommandProxyActivationInput {
  provider: string;
  command: string;
}

export type CommandProxyActivationResult =
  | {
      status: "ok";
      provider: string;
      env?: Record<string, string>;
      headerTransforms?: Array<{
        domain: string;
        headers: Record<string, string>;
      }>;
    }
  | {
      status: "auth_required" | "error";
      provider: string;
      message: string;
    };

/** Return the sandbox-visible acknowledgement path for one activation request. */
export function commandProxyAckPath(id: string): string {
  return `${COMMAND_PROXY_ACK_DIR}/${id}.json`;
}
