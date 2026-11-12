// A `codemode` call has one `gen_ai.execute_tool` span with
// `gen_ai.tool.name:codemode` and the `app.codemode.*` attributes below. Each
// nested call has its own child `gen_ai.execute_tool` span with the real tool
// name, `gen_ai.tool.dispatcher.name:codemode`, its own `app.guardian.*`
// decision, and the call id `<codemode call id>/c<n>`. A nested failure logs
// `agent.tool_call.failed` with that id. Policy: policies/observability.md.

/**
 * Why a Code Mode script did not return a result. `script`, `timeout`,
 * `aborted`, and `sandbox` are the pi-codemode error kinds. `memory` is a
 * `script` failure caused by the VM heap limit. `missing_tool` is a `script`
 * failure from reading a name that the VM does not declare, such as a
 * `modelOnly` tool.
 */
export type CodeModeErrorKind =
  | "script"
  | "timeout"
  | "memory"
  | "missing_tool"
  | "aborted"
  | "sandbox";

/** Safe measurements of one `codemode` tool call. */
export interface CodeModeTelemetry {
  /** UTF-8 bytes of the script source. */
  scriptBytes: number;
  /** Nested tool calls that the script made, including rejected calls. */
  callCount: number;
  /** Most nested tool calls that ran at the same time. */
  peakConcurrentCalls: number;
  /** Nested calls that action review did not allow (`ask` or `deny`). */
  rejectedCallCount: number;
  /** Nested calls refused because one drain had more calls than the batch limit. */
  batchLimitRejectedCallCount: number;
  /**
   * Calls to a tool catalog dispatcher, which the bridge fails with the call
   * to make instead (`codemode/redirect.ts`).
   */
  redirectedCallCount: number;
  /** Time until the VM was ready to run the script. Absent when it did not start. */
  vmStartMs?: number;
  /** Time from VM ready until the script result settled. Absent when it did not start. */
  runMs?: number;
  /** UTF-8 bytes of the script output and return value JSON. */
  outputBytes: number;
  /** Absent when the script returned a result. */
  errorKind?: CodeModeErrorKind;
}

/** Project Code Mode measurements to `app.codemode.*` attributes for the `codemode` tool span. */
export function codeModeSpanAttributes(
  telemetry: CodeModeTelemetry,
): Record<string, number | boolean | string> {
  return {
    "app.codemode.script.bytes": telemetry.scriptBytes,
    "app.codemode.call.count": telemetry.callCount,
    "app.codemode.call.peak_concurrency": telemetry.peakConcurrentCalls,
    "app.codemode.call.rejected_count": telemetry.rejectedCallCount,
    "app.codemode.call.batch_limit_rejected_count":
      telemetry.batchLimitRejectedCallCount,
    "app.codemode.call.redirected_count": telemetry.redirectedCallCount,
    ...(telemetry.vmStartMs !== undefined
      ? { "app.codemode.vm.start_ms": telemetry.vmStartMs }
      : undefined),
    ...(telemetry.runMs !== undefined
      ? { "app.codemode.run_ms": telemetry.runMs }
      : undefined),
    "app.codemode.output.bytes": telemetry.outputBytes,
    ...(telemetry.errorKind
      ? { "app.codemode.error.kind": telemetry.errorKind }
      : undefined),
  };
}
