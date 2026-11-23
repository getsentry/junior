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
import type {
  AnyToolDefinition,
  ToolExposure,
} from "@/chat/tool-support/definition";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";

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
 * input schemas. Only script-only tools are declared, because `searchTools`
 * does not find them. Deferred tools are not declared, like in Pi's coding
 * agent: the model gets their input schemas from `searchTools`, and scripts
 * can filter `ALL_TOOLS`. The same tools give the same text, so the section
 * is not sent again while the tools stay the same.
 */
export function renderScriptTools(
  tools: Record<string, AnyToolDefinition>,
): string {
  const named = (exposure: ToolExposure) =>
    Object.entries(tools)
      .filter(([, tool]) => effectiveToolExposure(tool) === exposure)
      .sort(([a], [b]) => a.localeCompare(b));
  const directNames = named("direct").map(([name]) => name);
  const declarations = named("codemode").map(([name, tool]) =>
    renderDeclaration(name, tool),
  );
  const deferredCount = named("deferred").length;
  return [
    ...(directNames.length > 0
      ? [
          `These tools from your tool list can also be called as \`tools.<name>(args)\`, with the same input: ${directNames.join(", ")}.`,
        ]
      : []),
    ...(declarations.length > 0
      ? ["declare const tools: {", ...declarations, "};"]
      : []),
    // The catalog tools are `modelOnly`. Models still call them from scripts.
    ...(deferredCount > 0
      ? [
          `Scripts can also call ${deferredCount} tools that are not listed here. To get the input_schema of one, call ${SEARCH_TOOLS_NAME} directly before the script. Then call it as \`tools.<tool_name>(args)\`. ${PARAMS_PREVIEW_HINT} In a script, \`ALL_TOOLS\` lists \`{ name, description }\` for every tool. Filter it; do not print all of it. A script cannot call ${SEARCH_TOOLS_NAME} or ${EXECUTE_TOOL_NAME}.`,
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
