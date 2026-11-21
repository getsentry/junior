/**
 * The `codemode` tool: the model writes a script that calls other tools with
 * `tools.<name>(args)`. The bridge runs it, and each nested call takes the
 * normal tool path. Only the script output, the return value, and one status
 * line for each call come back to the model.
 *
 * The tool is `modelOnly`, so a script cannot start another script. The
 * tool pipeline cuts long results for the model, the same as for other tools.
 */
import * as z from "zod";
import {
  CODE_MODE_SCRIPT_TIMEOUT_MS,
  runCodeModeScript,
  type CodeModeToolOptions,
} from "@/chat/codemode/bridge";
import {
  CODE_MODE_CALL_STATUS_TEXT,
  type CodeModeCall,
  type CodeModeResult,
} from "@/chat/codemode/result";
import { MAX_TOOL_ACTION_BATCH } from "@/chat/guardian/gate";
import { renderToolResultNudge } from "@/chat/plugins/after-tool-hooks";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";

// The tool list is in the `<script-tools>` system prompt section, so this text
// stays the same when the tools change. A changed tool definition would
// invalidate the provider prompt cache. When to pick a script over direct
// calls is a `<tool-policy>` rule in `system-prompt-rules.ts`.
const DESCRIPTION = [
  "Run a JavaScript script that calls other tools, and get back only what the script returns or prints.",
  "",
  "- `await tools.<name>(args)` runs one tool through the normal tool path, including action review. It resolves to the tool result, and rejects with an Error when the call fails or action review rejects it.",
  "- Arguments and results must be JSON-serializable.",
  "- Run calls at the same time (`Promise.all`) only when they do not depend on each other. Await a call before a call that needs its result. Run calls that change the same thing one after another.",
  "- Only the return value and the output of `text(value)` and `console.log(...)` come back to you. Return or print what you need.",
  `- The script has ${CODE_MODE_SCRIPT_TIMEOUT_MS / 1000} seconds, including its tool calls.`,
  `- Start at most ${MAX_TOOL_ACTION_BATCH} calls before the script awaits. A larger batch fails, and none of its calls run.`,
  "- The result lists each tool call and its status. When action review rejects a call, do what its instructions say, such as ask the user, before you try it again.",
  "- `<script-tools>` in the system prompt lists the tools that a script can call.",
].join("\n");

function renderCall(call: CodeModeCall, index: number): string {
  const line = `${index + 1}. ${call.toolName}: ${CODE_MODE_CALL_STATUS_TEXT[call.status]}`;
  const notes = [
    ...(call.error ? [call.error] : []),
    ...(call.nudges ?? []).map(renderToolResultNudge),
  ];
  return [
    line,
    ...notes.map((note) => `   ${note.replace(/\n/g, "\n   ")}`),
  ].join("\n");
}

function renderValue(result: CodeModeResult): string | undefined {
  if (result.value === undefined) {
    return undefined;
  }
  // A returned string shows as plain text.
  return typeof result.value === "string"
    ? result.value
    : JSON.stringify(result.value);
}

function renderResult(result: CodeModeResult): string {
  const value = renderValue(result);
  const rejected = result.calls.filter((call) => call.status === "rejected");
  return [
    result.ok
      ? "Script completed."
      : `Script failed (${result.error?.kind ?? "script"}).`,
    ...(result.calls.length > 0
      ? [
          `Tool calls (${result.calls.length}):`,
          ...result.calls.map(renderCall),
        ]
      : []),
    ...(rejected.length > 0
      ? [
          `Action review rejected ${rejected.length} of these calls. Follow the instructions of each rejected call.`,
        ]
      : []),
    ...(result.error ? ["Error:", result.error.message] : []),
    ...(result.output ? ["Output:", result.output] : []),
    ...(value !== undefined ? ["Return value:", value] : []),
  ].join("\n");
}

/**
 * Create the `codemode` tool for one Run's script tools and pipeline.
 *
 * @runBuilt codemode
 */
export function createCodeModeTool(options: CodeModeToolOptions) {
  const { countToolCall, modelOnlyTools, pipeline, scriptTools } = options;
  return zodTool({
    annotations: {
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description: DESCRIPTION,
    // One script at a time. Its nested calls run at the same time.
    executionMode: "sequential",
    exposure: "modelOnly",
    inputSchema: z
      .object({
        code: z
          .string()
          .min(1)
          .describe(
            "JavaScript source: the body of an async function, so top-level `await` and `return` work. Raw code, not JSON and not in a code fence. It runs in a QuickJS VM with no Node, file system, network, or timers.",
          ),
      })
      .strict(),
    outputSchema: juniorToolOutputSchema,
    execute: async ({ code }, { signal, toolCallId }) => {
      if (!toolCallId) {
        throw new Error("codemode requires a tool call id.");
      }
      const result = await runCodeModeScript({
        countToolCall,
        modelOnlyTools,
        pipeline,
        signal,
        source: code,
        toolCallId,
        tools: scriptTools,
      });
      return {
        content: [{ type: "text", text: renderResult(result) }],
        details: result,
      };
    },
  });
}
