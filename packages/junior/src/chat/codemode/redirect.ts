/**
 * Models call `modelOnly` tools from scripts, but those tools run only as
 * direct calls. The VM declares them anyway, so such a call reaches the
 * bridge with its arguments, and the bridge fails it with the call to make
 * instead. Without a declaration, pi fails the property read with a hint
 * that does not apply to Junior, and a script that catches it hides the
 * mistake from the model.
 *
 * Tool exposure decides which names these are. This module owns only the
 * text that each one gets.
 */
import type { AnyToolDefinition } from "@/chat/tools/definition";
import { EXECUTE_TOOL_NAME } from "@/chat/tools/execute-tool";
import { SEARCH_TOOLS_NAME } from "@/chat/tools/search-tools";

function executeToolRedirect(
  input: unknown,
  scriptTools: Record<string, AnyToolDefinition>,
): string {
  const toolName =
    input !== null && typeof input === "object" && "tool_name" in input
      ? input.tool_name
      : undefined;
  if (typeof toolName !== "string" || toolName.length === 0) {
    return `${EXECUTE_TOOL_NAME} does not run in a script. Call tools.<tool_name>(arguments) directly.`;
  }
  if (Object.hasOwn(scriptTools, toolName)) {
    return `${EXECUTE_TOOL_NAME} does not run in a script. Call tools.${toolName}(arguments) directly, with only the object from the ${EXECUTE_TOOL_NAME} arguments field.`;
  }
  return `${EXECUTE_TOOL_NAME} does not run in a script, and ${toolName} is not a script tool. Call ${toolName} outside the script.`;
}

/**
 * The error for a script call to a `modelOnly` tool. Without `input`, the
 * text describes the tool.
 */
export function scriptRedirect(
  toolName: string,
  input: unknown,
  scriptTools: Record<string, AnyToolDefinition>,
): string {
  switch (toolName) {
    case EXECUTE_TOOL_NAME:
      return executeToolRedirect(input, scriptTools);
    case SEARCH_TOOLS_NAME:
      return `${SEARCH_TOOLS_NAME} does not run in a script. Call it directly before the script, then call each result as tools.<tool_name>(args).`;
    default:
      return `${toolName} does not run in a script. Call it directly, outside the script.`;
  }
}

/** VM declarations for the `modelOnly` tools. */
export function redirectDeclarations(
  modelOnlyTools: readonly string[],
  scriptTools: Record<string, AnyToolDefinition>,
): Array<{ name: string; description: string }> {
  return modelOnlyTools.map((name) => ({
    name,
    description: scriptRedirect(name, undefined, scriptTools),
  }));
}
