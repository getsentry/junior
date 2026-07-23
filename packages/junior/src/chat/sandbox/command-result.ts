import type {
  SandboxEgressAuthRequiredSignal,
  SandboxEgressPermissionDeniedSignal,
} from "@/chat/sandbox/egress/session";
import { makeStructuredToolResult } from "@/chat/tool-support/structured-result";

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
  return makeStructuredToolResult({
    ok: params.ok,
    status: params.ok ? "success" : "error",
    target: params.command,
    data: {
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
    },
    truncated: params.stdout_truncated || params.stderr_truncated,
    ...(!params.ok
      ? {
          error: {
            kind: params.aborted
              ? "outcome_unknown"
              : params.timed_out
                ? "timeout"
                : "nonzero_exit",
            message: params.aborted
              ? "Command was interrupted before its outcome was confirmed. It may have produced side effects; reconcile external state before retrying or reporting failure."
              : params.stderr.trim() ||
                `Command exited with code ${params.exit_code}`,
            retryable: params.timed_out,
          },
        }
      : {}),
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
    ...(params.auth_required ? { auth_required: params.auth_required } : {}),
    ...(params.permission_denied
      ? { permission_denied: params.permission_denied }
      : {}),
  });
}
