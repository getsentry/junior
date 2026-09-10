import type {
  SandboxEgressAuthRequiredSignal,
  SandboxEgressPermissionDeniedSignal,
} from "@/chat/sandbox/egress/session";
import { makeStructuredToolOutput } from "@/chat/tool-support/structured-result";

export interface SandboxCommandOutcome {
  ok: boolean;
  command: string;
  cwd: string;
  exit_code: number;
  signal: null;
  timed_out: boolean;
  aborted?: boolean;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  auth_required?: SandboxEgressAuthRequiredSignal;
  permission_denied?: SandboxEgressPermissionDeniedSignal;
}

/** Format one shell command outcome as Junior's structured tool result. */
export function formatSandboxCommandResult(params: SandboxCommandOutcome) {
  return makeStructuredToolOutput({
    target: params.command,
    truncated: params.stdout_truncated || params.stderr_truncated,
    command: params.command,
    cwd: params.cwd,
    exit_code: params.exit_code,
    signal: params.signal,
    timed_out: params.timed_out,
    aborted: Boolean(params.aborted),
    stdout: params.stdout,
    stderr: params.stderr,
    stdout_truncated: params.stdout_truncated,
    stderr_truncated: params.stderr_truncated,
    ...(params.auth_required ? { auth_required: params.auth_required } : undefined),
    ...(params.permission_denied
      ? { permission_denied: params.permission_denied }
      : undefined),
  });
}
