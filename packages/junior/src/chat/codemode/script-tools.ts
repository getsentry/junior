/** The `<script-tools>` system prompt section of the `codemode` tool. */
import {
  PARAMS_PREVIEW_HINT,
  SEARCH_TOOLS_NAME,
  summarizeModelVisibleDescription,
} from "@/chat/tool-support/catalog-search";
import { EXECUTE_TOOL_NAME } from "@/chat/tool-support/catalog-tool-call";
import {
  renderToolSignature,
  type CodemodeJsonSchema,
} from "@earendil-works/pi-codemode";
import { effectiveToolExposure } from "@/chat/tool-exposure";
import type { AnyToolDefinition } from "@/chat/tool-support/definition";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { estimateTextTokens } from "@/chat/services/token-estimate";

/**
 * Estimated tokens that the tool declarations may use in the description.
 * Pi's coding agent uses the same default.
 */
const DECLARATION_BUDGET_TOKENS = 3_000;

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
    return schema;
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
  };
}

/** One member of `declare const tools`, with its description as a doc comment. */
function renderDeclaration(name: string, tool: AnyToolDefinition): string {
  const description = summarizeModelVisibleDescription(
    tool.description,
  ).replace(/\*\//g, "*\\/");
  const outputSchema = scriptOutputSchema(tool.outputSchema);
  const signature = renderToolSignature({
    name,
    inputSchema: tool.inputSchema,
    ...(outputSchema ? { outputSchema } : undefined),
  }).trim();
  return `  /** ${description} */\n  ${signature.replace(/\n/g, "\n  ")}`;
}

/**
 * Tell the script which tools it may call, for the `<script-tools>` system
 * prompt section. Direct tools are only named: the model already has their
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
          `${omitted} more tools are not declared here. To find one, call ${SEARCH_TOOLS_NAME} directly before the script. Then call each result as \`tools.<tool_name>(args)\`, with its input_schema. ${PARAMS_PREVIEW_HINT} A script cannot call ${SEARCH_TOOLS_NAME} or ${EXECUTE_TOOL_NAME}.`,
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
