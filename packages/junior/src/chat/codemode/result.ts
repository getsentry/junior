import type { CodeModeErrorKind } from "@/chat/codemode/telemetry";
import type { ToolActionRejectionMarker } from "@/chat/guardian/history";

/**
 * Name of the tool that runs a Code Mode script. Nested calls use it as
 * their dispatcher name.
 */
export const CODEMODE_TOOL_NAME = "codemode";

/**
 * What happened to one nested call. `interrupted`: the call started and the
 * host aborted it, so its outcome is unknown. `not_started`: the script
 * ended before the call ran.
 */
export type CodeModeCallStatus =
  | "ok"
  | "error"
  | "rejected"
  | "interrupted"
  | "not_started";

/** One tool call that a script made. */
export interface CodeModeCall {
  /** `<codemode call id>/c<n>`, where `n` is the VM number for the call. */
  id: string;
  toolName: string;
  status: CodeModeCallStatus;
  /** Why the call failed, or Guardian's instructions and reason. */
  error?: string;
  /**
   * The gate's marker for a call that action review rejected (`ask` or
   * `deny`). `guardian/history.ts` restores it at the start of a Run.
   */
  guardianActionRejection?: ToolActionRejectionMarker;
}

/**
 * Result of one script. The `codemode` tool puts it in its result details,
 * so the calls that finished stay visible after a timeout or abort.
 */
export interface CodeModeResult {
  /** True when the script returned or called `exit()`. */
  ok: boolean;
  /** Return value of the script. A value cut to the output limit is a string. */
  value?: unknown;
  /** Why the script did not return. */
  error?: { kind: CodeModeErrorKind; message: string };
  /** Text from `text()` and `console.*`, cut to the output limit. */
  output: string;
  /** True when `output` or `value` was cut to the output limit. */
  truncated: boolean;
  /** Every nested call, in the order the script made them. */
  calls: CodeModeCall[];
}
