/**
 * The `codemode` tool: the model writes a script that calls other tools with
 * `tools.<name>(args)`. The bridge runs it, and each nested call takes the
 * normal tool path. Only the script output, the return value, and one status
 * line for each call come back to the model.
 *
 * The tool is `modelOnly`, so a script cannot start another script. The
 * tool pipeline cuts long results for the model, the same as for other tools.
 */
import {
  renderToolSignature,
  type CodemodeJsonSchema,
} from "@earendil-works/pi-codemode";
import * as z from "zod";
import {
  CODE_MODE_SCRIPT_TIMEOUT_MS,
  runCodeModeScript,
  type CodeModeScriptRun,
} from "@/chat/codemode/bridge";
import {
  CODE_MODE_CALL_STATUS_TEXT,
  type CodeModeCall,
  type CodeModeResult,
} from "@/chat/codemode/result";
import { MAX_TOOL_ACTION_BATCH } from "@/chat/guardian/gate";
import { effectiveToolExposure } from "@/chat/tool-exposure";
import type { AnyToolDefinition } from "@/chat/tools/definition";
import { EXECUTE_TOOL_NAME } from "@/chat/tools/execute-tool";
import {
  SEARCH_TOOLS_NAME,
  summarizeModelVisibleDescription,
} from "@/chat/tools/search-tools";
import { renderToolResultNudge } from "@/chat/plugins/after-tool-hooks";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { estimateTextTokens } from "@/chat/services/token-estimate";

/**
 * Estimated tokens that the tool declarations may use in the description.
 * Pi's coding agent uses the same default.
 */
const DECLARATION_BUDGET_TOKENS = 3_000;

/** Services of one Run that the tool needs. */
export interface CodeModeToolOptions {
  /** Tools a script may call: `scriptTools` from `planToolExposure`. */
  scriptTools: Record<string, AnyToolDefinition>;
  modelOnlyTools: CodeModeScriptRun["modelOnlyTools"];
  pipeline: CodeModeScriptRun["pipeline"];
  /** Charge one nested call to the Turn's durable tool-call total. */
  countToolCall(): number;
}

/** Fields of the shared tool result envelope. They say nothing about one tool. */
const ENVELOPE_FIELDS = new Set<string>(juniorToolOutputSchema.keyof().options);

/**
 * The result type a script sees: the tool's own fields, without the shared
 * envelope fields. Undefined, so the type is `unknown`, when no field is left.
 */
function scriptOutputSchema(
  schema: AnyToolDefinition["outputSchema"],
): CodemodeJsonSchema | undefined {
  const { properties, required, ...rest } = (schema ?? {}) as {
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: unknown;
  };
  if (!properties) {
    return schema as CodemodeJsonSchema | undefined;
  }
  const own = Object.entries(properties).filter(
    ([field]) => !ENVELOPE_FIELDS.has(field),
  );
  if (own.length === 0) {
    return undefined;
  }
  const { additionalProperties: _additional, ...objectSchema } = rest;
  return {
    ...objectSchema,
    properties: Object.fromEntries(own),
    ...(required
      ? { required: required.filter((field) => !ENVELOPE_FIELDS.has(field)) }
      : undefined),
  } as CodemodeJsonSchema;
}

/** One member of `declare const tools`, with its description as a doc comment. */
function renderDeclaration(name: string, tool: AnyToolDefinition): string {
  const description = summarizeModelVisibleDescription(
    tool.description,
  ).replace(/\*\//g, "*\\/");
  const outputSchema = scriptOutputSchema(tool.outputSchema);
  const signature = renderToolSignature({
    name,
    inputSchema: tool.inputSchema as CodemodeJsonSchema,
    ...(outputSchema ? { outputSchema } : undefined),
  }).trim();
  return `  /** ${description} */\n  ${signature.replace(/\n/g, "\n  ")}`;
}

/**
 * Tell the script which tools it may call, for the `<script-tools>` Turn
 * context section. Direct tools are only named: the model already has their
 * input schemas. The other tools are declared within the token budget,
 * cheapest first, so that the most tools fit. The others stay callable. The
 * model finds their input with `searchTools`. Script-only tools come first,
 * because `searchTools` does not find them. The same tools give the same
 * text, so the section is not sent again while the tools stay the same.
 */
export function renderScriptTools(
  tools: Record<string, AnyToolDefinition>,
): string {
  const directNames = Object.entries(tools)
    .filter(([, tool]) => effectiveToolExposure(tool) === "direct")
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b));
  const entries = Object.entries(tools)
    .filter(([, tool]) => effectiveToolExposure(tool) !== "direct")
    .map(([name, tool]) => {
      const text = renderDeclaration(name, tool);
      return {
        cost: estimateTextTokens(text),
        name,
        scriptOnly: effectiveToolExposure(tool) === "codemode",
        text,
      };
    })
    .sort(
      (a, b) =>
        Number(b.scriptOnly) - Number(a.scriptOnly) ||
        a.cost - b.cost ||
        a.name.localeCompare(b.name),
    );
  let remaining = DECLARATION_BUDGET_TOKENS;
  const shown: typeof entries = [];
  for (const entry of entries) {
    if (entry.cost > remaining) {
      continue;
    }
    remaining -= entry.cost;
    shown.push(entry);
  }
  shown.sort((a, b) => a.name.localeCompare(b.name));
  const omitted = entries.length - shown.length;
  return [
    ...(directNames.length > 0
      ? [
          `These tools from your tool list can also be called as \`tools.<name>(args)\`, with the same input: ${directNames.join(", ")}.`,
        ]
      : []),
    ...(shown.length > 0
      ? ["declare const tools: {", ...shown.map((entry) => entry.text), "};"]
      : []),
    // The catalog tools are `modelOnly`. Models still call them from scripts.
    ...(omitted > 0
      ? [
          `${omitted} more tools are not declared here. To find one, call ${SEARCH_TOOLS_NAME} directly before the script. Then call each result as \`tools.<tool_name>(args)\`, with its input_schema. A script cannot call ${SEARCH_TOOLS_NAME} or ${EXECUTE_TOOL_NAME}.`,
        ]
      : []),
    // MCP tools are not script tools. Only `callMcpTool` reaches them.
    ...(Object.hasOwn(tools, "callMcpTool")
      ? [
          "Call an MCP tool as `tools.callMcpTool({ tool_name, arguments })`. Its `result` field holds the structured content of the MCP tool, or its text. `tools.mcp__<provider>__<tool>` does not exist.",
        ]
      : []),
  ].join("\n");
}

// The tool list is in the `<script-tools>` Turn context section, so this text
// stays the same when the tools change. A changed tool definition would
// invalidate the provider prompt cache.
const DESCRIPTION = [
  "Run a JavaScript script that calls other tools, and get back only what the script returns or prints. When a task needs several tool calls, such as the same lookup for many items or a search and then a read of each result, use one script instead of separate calls. For one call, or when you must read a result before you decide the next step, call the tools directly.",
  "",
  "- `await tools.<name>(args)` runs one tool through the normal tool path, including action review. It resolves to the tool result, and rejects with an Error when the call fails or action review rejects it.",
  "- Arguments and results must be JSON-serializable.",
  "- Run calls at the same time (`Promise.all`) only when they do not depend on each other. Await a call before a call that needs its result. Run calls that change the same thing one after another.",
  "- Only the return value and the output of `text(value)` and `console.log(...)` come back to you. Return or print what you need.",
  `- The script has ${CODE_MODE_SCRIPT_TIMEOUT_MS / 1000} seconds, including its tool calls.`,
  `- Start at most ${MAX_TOOL_ACTION_BATCH} calls before the script awaits. A larger batch fails, and none of its calls run.`,
  "- The result lists each tool call and its status. When action review rejects a call, do what its instructions say, such as ask the user, before you try it again.",
  "- `<script-tools>` in the runtime context lists the tools that a script can call. Only the latest `<script-tools>` is current.",
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

/** Create the `codemode` tool for one Run's script tools and pipeline. */
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
