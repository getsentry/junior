/**
 * Runs one model-written script in pi-codemode and sends each `tools.x()`
 * call through the normal tool pipeline.
 *
 * The VM runs in `start()` mode: its clock and randomness are fixed, and this
 * module answers each call. The calls of one VM drain (between two `idle`
 * messages) go to action review as one batch. A later change can replay a
 * script from a log of its results, because the answers are numbered in the
 * order they were delivered.
 */
import { randomInt } from "node:crypto";
import {
  CodemodeSandbox,
  type CodemodeHostCall,
  type CodemodeOutcome,
  type CodemodeResult,
  type CodemodeRun,
} from "@earendil-works/pi-codemode";
import { botConfig } from "@/chat/config";
import {
  MAX_TOOL_ACTION_BATCH,
  type ToolAction,
  type ToolActionReviewResult,
} from "@/chat/guardian/gate";
import type { ScriptCallStatus } from "@/chat/guardian/proposal";
import * as Sentry from "@/chat/sentry";
import { TURN_LIMIT_WRAP_UP_MESSAGE } from "@/chat/services/turn-limit";
import type { AnyToolDefinition } from "@/chat/tools/definition";
import type {
  ScriptToolCallOutcome,
  ToolPipeline,
} from "@/chat/tool-support/pi-tool-adapter";
import {
  codeModeSpanAttributes,
  type CodeModeErrorKind,
  type CodeModeTelemetry,
} from "@/chat/codemode/telemetry";
import type { CodeModeCall, CodeModeResult } from "@/chat/codemode/result";

/** Deadline of one script, including the time its nested calls take. */
export const CODE_MODE_SCRIPT_TIMEOUT_MS = 120_000;

/**
 * Output limit: pi's default `max_output_tokens` (10k tokens), at the 4
 * characters per token of `estimateTextTokens`. The output and the return
 * value share it.
 */
export const CODE_MODE_MAX_OUTPUT_CHARS = 10_000 * 4;
const MAX_CALL_ERROR_CHARS = 2_000;

/**
 * How long a script that ended waits for its nested calls. It is longer than
 * the adapter's 2s executor grace, so a preempted executor still reports, and
 * shorter than the agent's 5s abort settle grace. A call that ignores the
 * abort before its executor (in a plugin hook, for example) is detached.
 */
const CALL_SETTLE_GRACE_MS = 3_000;
const TRUNCATED = "\n[truncated]";

/** One nested call while the script runs. */
interface ScriptCall extends CodeModeCall {
  /** What the script passed. Guardian sees it as provenance. */
  input: unknown;
  /** Action review allowed the call and it began to run. */
  started: boolean;
}

/** What {@link runCodeModeScript} returns. */
export interface CodeModeScriptOutcome {
  result: CodeModeResult;
  /**
   * The uncut output and return value JSON, only when `result.truncated`.
   * The caller decides where to keep them.
   */
  untruncated?: { output: string; value?: string };
}

/** Run inputs for {@link runCodeModeScript}. */
export interface CodeModeScriptRun {
  /** Id of the `codemode` tool call. Nested calls use `<id>/c<n>`. */
  toolCallId: string;
  /** Script source: the body of an async function. */
  source: string;
  /** Tools the script may call: `scriptTools` from `planToolExposure`. */
  tools: Record<string, AnyToolDefinition>;
  pipeline: Pick<ToolPipeline, "callFromScript" | "reviewScriptCalls">;
  /** Charge one call to the Turn's durable tool-call total; return the total. */
  countToolCall(): number;
  /** The Run's abort signal. It stops the VM and every pending nested call. */
  signal?: AbortSignal;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * Wait for the nested calls of an ended script, at most
 * `CALL_SETTLE_GRACE_MS`. A drain that is still starting can add calls.
 */
async function settleCalls(pending: Set<Promise<void>>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<void>((done) => {
    timer = setTimeout(done, CALL_SETTLE_GRACE_MS);
  });
  const settled = (async () => {
    while (pending.size > 0) {
      await Promise.allSettled(pending);
    }
  })();
  try {
    await Promise.race([settled, grace]);
  } finally {
    clearTimeout(timer);
  }
}

function cut(text: string, maxChars: number): string {
  return text.length <= maxChars
    ? text
    : `${text.slice(0, Math.max(0, maxChars - TRUNCATED.length))}${TRUNCATED}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The value a script gets for a call: the structured details, or the text of
 * a result that has only content.
 */
function scriptValue(
  result: Extract<ScriptToolCallOutcome, { status: "ok" }>["result"],
): unknown {
  const { content, details } = result;
  const contentOnly =
    details !== null &&
    typeof details === "object" &&
    !Array.isArray(details) &&
    Object.keys(details).length === 0;
  if (!contentOnly) {
    return details;
  }
  return content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}

function provenanceStatus(call: ScriptCall): ScriptCallStatus | undefined {
  switch (call.status) {
    case "ok":
      return "completed";
    case "rejected":
      return "rejected";
    case "error":
    case "interrupted":
      return "failed";
    default:
      return undefined;
  }
}

function vmErrorKind(result: CodemodeResult): CodeModeErrorKind | undefined {
  if (result.ok) {
    return undefined;
  }
  const { error } = result;
  return error.kind === "script" &&
    error.name === "InternalError" &&
    error.message.includes("out of memory")
    ? "memory"
    : error.kind;
}

/** Cut the output and return value to share the output limit. */
function boundedOutput(result: CodemodeResult) {
  const output = result.output
    .map((item) =>
      item.type === "text" ? item.text : `[image ${item.mimeType} not shown]`,
    )
    .join("\n");
  const valueJson =
    result.ok && result.value !== undefined
      ? (JSON.stringify(result.value) ?? "")
      : "";
  const outputBytes = Buffer.byteLength(output) + Buffer.byteLength(valueJson);
  if (output.length + valueJson.length <= CODE_MODE_MAX_OUTPUT_CHARS) {
    return {
      output,
      outputBytes,
      truncated: false,
      value: result.ok ? result.value : undefined,
    };
  }
  // Each part keeps what it needs up to half the limit; the larger part also
  // gets what the smaller part does not use.
  const half = CODE_MODE_MAX_OUTPUT_CHARS / 2;
  const valueChars =
    valueJson.length <= half
      ? valueJson.length
      : Math.max(half, CODE_MODE_MAX_OUTPUT_CHARS - output.length);
  const value =
    valueJson.length <= valueChars
      ? result.ok
        ? result.value
        : undefined
      : cut(valueJson, valueChars);
  return {
    output: cut(output, CODE_MODE_MAX_OUTPUT_CHARS - valueChars),
    outputBytes,
    truncated: true,
    untruncated: { output, ...(valueJson ? { value: valueJson } : undefined) },
    value,
  };
}

/**
 * Run one Code Mode script. Each nested call takes the normal tool path:
 * argument checks, plugin hooks, action review (one batch per VM drain),
 * credentials and auth handling, then the executor. The script decides
 * concurrency: `await a(); await b()` runs the calls one after the other,
 * and `Promise.all` runs them at the same time. `executionMode` applies only
 * to direct calls. A tool whose calls must not overlap serializes them in
 * its own executor.
 *
 * The result lists every nested call, also after a timeout or abort. An
 * authorization pause from a nested call stops the script and throws, so the
 * Run can pause.
 */
export async function runCodeModeScript(
  run: CodeModeScriptRun,
): Promise<CodeModeScriptOutcome> {
  // pi-codemode reports calls from a worker callback, which loses the async
  // context. Run each nested call with the `codemode` span active.
  const parentSpan = Sentry.getActiveSpan();
  const inParentSpan = <T>(work: () => Promise<T>): Promise<T> =>
    parentSpan ? Sentry.withActiveSpan(parentSpan, work) : work();

  // Aborts the VM and every pending nested call: on Run abort, when the
  // script ends, or on an authorization pause.
  const controller = new AbortController();
  const onAbort = () => controller.abort(run.signal?.reason);
  if (run.signal?.aborted) {
    onAbort();
  } else {
    run.signal?.addEventListener("abort", onAbort, { once: true });
  }

  const calls: ScriptCall[] = [];
  const pending = new Set<Promise<void>>();
  const telemetry: CodeModeTelemetry = {
    scriptBytes: Buffer.byteLength(run.source),
    callCount: 0,
    peakConcurrentCalls: 0,
    rejectedCallCount: 0,
    batchLimitRejectedCallCount: 0,
    outputBytes: 0,
    outputTruncated: false,
  };
  let drain: CodemodeHostCall[] = [];
  let lastSeq = 0;
  let runningCalls = 0;
  let pauseError: unknown;

  const track = (work: Promise<void>) => {
    pending.add(work);
    void work.finally(() => pending.delete(work));
  };

  let vm: CodemodeRun | undefined;
  /**
   * Answer one call. Answers are numbered in delivery order. Returns the
   * error the script got instead when the value cannot make a JSON round
   * trip.
   */
  const answer = (
    hostCallId: number,
    outcome: CodemodeOutcome,
  ): string | undefined => {
    if (!vm || vm.finished) {
      return undefined;
    }
    const seq = ++lastSeq;
    try {
      vm.deliver(seq, Date.now(), hostCallId, outcome);
      return undefined;
    } catch (error) {
      // `deliver` checks the value before it records the seq, so the seq
      // is still unused.
      const message = `The tool result cannot be sent to the script: ${errorMessage(error)}`;
      vm.deliver(seq, Date.now(), hostCallId, { ok: false, message });
      return message;
    }
  };

  const fail = (
    call: ScriptCall,
    hostCallId: number,
    status: "error" | "rejected",
    message: string,
  ) => {
    call.status = status;
    call.error = cut(message, MAX_CALL_ERROR_CHARS);
    answer(hostCallId, { ok: false, message });
  };

  const runCall = async (
    host: CodemodeHostCall,
    call: ScriptCall,
    tool: AnyToolDefinition,
    review: (action: ToolAction) => Promise<ToolActionReviewResult>,
  ) => {
    let outcome: ScriptToolCallOutcome;
    try {
      outcome = await inParentSpan(() =>
        run.pipeline.callFromScript({
          toolCallId: call.id,
          toolName: call.toolName,
          tool,
          input: host.args,
          signal: controller.signal,
          review: async (action) => {
            const result = await review(action);
            if (!result.allowed) {
              return result;
            }
            controller.signal.throwIfAborted();
            call.started = true;
            runningCalls += 1;
            telemetry.peakConcurrentCalls = Math.max(
              telemetry.peakConcurrentCalls,
              runningCalls,
            );
            return result;
          },
        }),
      );
    } catch (error) {
      // Only an authorization pause throws. The Run must pause.
      pauseError ??= error;
      controller.abort(error);
      call.status = call.started ? "interrupted" : "not_started";
      return;
    } finally {
      if (call.started) {
        runningCalls -= 1;
      }
    }
    switch (outcome.status) {
      case "ok": {
        const undeliverable = answer(host.id, {
          ok: true,
          value: scriptValue(outcome.result),
        });
        call.status = undeliverable ? "error" : "ok";
        if (undeliverable) {
          call.error = cut(undeliverable, MAX_CALL_ERROR_CHARS);
        }
        return;
      }
      case "rejected":
        telemetry.rejectedCallCount += 1;
        call.guardianActionRejection = outcome.marker;
        fail(call, host.id, "rejected", outcome.error.message);
        return;
      case "error":
        fail(call, host.id, "error", outcome.error.message);
        return;
      case "preempted":
        call.status = call.started ? "interrupted" : "not_started";
        return;
    }
  };

  /** Start the calls of one drain, and review them as one batch. */
  const flush = async () => {
    const hostCalls = drain;
    drain = [];
    const accepted: Array<{
      call: ScriptCall;
      host: CodemodeHostCall;
      tool: AnyToolDefinition;
    }> = [];
    for (const host of hostCalls) {
      const call: ScriptCall = {
        id: `${run.toolCallId}/c${host.id}`,
        input: host.args,
        started: false,
        status: "not_started",
        toolName: host.name,
      };
      calls.push(call);
      // The VM only declares script tools. Check again, so no other tool
      // runs from a script.
      const tool =
        host.target === "tool" && Object.hasOwn(run.tools, host.name)
          ? run.tools[host.name]
          : undefined;
      if (!tool) {
        fail(call, host.id, "error", `${host.name} is not a script tool.`);
        continue;
      }
      // Past the limit, the call gets the wrap-up message of a blocked
      // direct call, so the model replies with its progress.
      if (run.countToolCall() > botConfig.maxToolCallsPerTurn) {
        fail(call, host.id, "error", TURN_LIMIT_WRAP_UP_MESSAGE);
        continue;
      }
      accepted.push({ call, host, tool });
    }
    if (accepted.length === 0) {
      return;
    }

    const rawActions = accepted.map(
      ({ call, tool }): ToolAction => ({
        toolCallId: call.id,
        toolName: call.toolName,
        tool,
        input: (call.input ?? {}) as Record<string, unknown>,
      }),
    );
    if (accepted.length > MAX_TOOL_ACTION_BATCH) {
      // The gate fails an oversized batch before any review. Refuse the
      // whole drain before hooks run, with the gate's error.
      const results = await run.pipeline.reviewScriptCalls(
        rawActions,
        controller.signal,
      );
      telemetry.batchLimitRejectedCallCount += accepted.length;
      for (const { call, host } of accepted) {
        const result = results.get(call.id);
        fail(
          call,
          host.id,
          "error",
          result && !result.allowed
            ? result.error.message
            : `Too many tool calls at once (${accepted.length}).`,
        );
      }
      return;
    }

    // Each call reaches review after its own checks and hooks. The batch
    // waits until each call has an action or has failed.
    const submissions = accepted.map(() => deferred<ToolAction | undefined>());
    const reviews = (async () => {
      const actions = (
        await Promise.all(submissions.map((entry) => entry.promise))
      ).filter((action): action is ToolAction => action !== undefined);
      if (actions.length === 0) {
        return new Map<string, ToolActionReviewResult>();
      }
      // Calls of this drain have no status yet, so only earlier calls count.
      const earlier = calls.flatMap((call) => {
        const status = provenanceStatus(call);
        return status
          ? [{ input: call.input, status, toolName: call.toolName }]
          : [];
      });
      return await run.pipeline.reviewScriptCalls(
        actions.map((action) => ({
          ...action,
          attemptId: run.toolCallId,
          script: { source: run.source, calls: earlier },
        })),
        controller.signal,
      );
    })();
    // Each waiting call gets this failure through its own review.
    void reviews.catch(() => undefined);

    accepted.forEach(({ call, host, tool }, index) => {
      const submission = submissions[index]!;
      track(
        runCall(host, call, tool, async (action) => {
          submission.resolve(action);
          return (await reviews).get(action.toolCallId)!;
        }).finally(() => submission.resolve(undefined)),
      );
    });
  };

  const sandbox = new CodemodeSandbox();
  const startedAt = performance.now();
  let readyAt: number | undefined;
  try {
    vm = sandbox.start(run.source, {
      startedAt: Date.now(),
      seed: randomInt(0, 2 ** 32),
      tools: Object.entries(run.tools).map(([name, tool]) => ({
        name,
        description: tool.description,
      })),
      signal: controller.signal,
      timeoutMs: CODE_MODE_SCRIPT_TIMEOUT_MS,
      onStarted: () => {
        readyAt = performance.now();
      },
      onCall: (call) => {
        telemetry.callCount += 1;
        drain.push(call);
      },
      onIdle: () => {
        if (drain.length > 0) {
          track(flush());
        }
      },
    });
    let vmResult: CodemodeResult;
    try {
      vmResult = await vm.result;
    } finally {
      controller.abort();
    }
    const settledAt = performance.now();
    await settleCalls(pending);
    // A started call with no outcome yet was cut off, or is detached.
    for (const call of calls) {
      if (call.status === "not_started" && call.started) {
        call.status = "interrupted";
      }
    }
    // Calls of the last drain never reached an idle, so they did not start.
    for (const host of drain) {
      calls.push({
        id: `${run.toolCallId}/c${host.id}`,
        input: host.args,
        started: false,
        status: "not_started",
        toolName: host.name,
      });
    }
    if (pauseError !== undefined) {
      throw pauseError;
    }

    const output = boundedOutput(vmResult);
    const errorKind = vmErrorKind(vmResult);
    Object.assign(telemetry, {
      outputBytes: output.outputBytes,
      outputTruncated: output.truncated,
      ...(readyAt !== undefined
        ? {
            vmStartMs: Math.round(readyAt - startedAt),
            runMs: Math.round(settledAt - readyAt),
          }
        : undefined),
      ...(errorKind ? { errorKind } : undefined),
    });
    return {
      result: {
        ok: vmResult.ok,
        ...(vmResult.ok
          ? { value: output.value }
          : {
              error: {
                kind: errorKind!,
                message: vmResult.error.stack ?? vmResult.error.message,
              },
            }),
        output: output.output,
        truncated: output.truncated,
        calls: calls.map(
          ({ input: _input, started: _started, ...call }) => call,
        ),
      },
      ...(output.untruncated ? { untruncated: output.untruncated } : undefined),
    };
  } finally {
    run.signal?.removeEventListener("abort", onAbort);
    parentSpan?.setAttributes(codeModeSpanAttributes(telemetry));
    await sandbox.close();
  }
}
