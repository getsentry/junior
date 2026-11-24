import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { EXECUTE_TOOL_NAME } from "@/chat/tool-support/catalog-tool-call";
import { SEARCH_TOOLS_NAME } from "@/chat/tool-support/catalog-search";
import { CODEMODE_TOOL_NAME } from "@/chat/codemode/result";
import type { AnyToolDefinition } from "@/chat/tool-support/definition";
import {
  findToolNameHint,
  renderToolNameHint,
} from "@/chat/tool-support/tool-name-suggestions";
import type { PiMessage } from "@/chat/pi/messages";
import { isToolResultMessage } from "@/chat/pi/transcript";

/** Where each tool name of a Turn can be called from. */
export interface ToolCallRoutes {
  catalogTools: Record<string, AnyToolDefinition>;
  /** Names in the model tool list. */
  modelToolNames: ReadonlySet<string>;
  scriptTools: Record<string, AnyToolDefinition>;
}

/**
 * Error text for a direct call to a name that is not in the model tool list.
 * It names the next call, because Pi's own text names none.
 */
export function missingToolText(
  toolName: string,
  routes: ToolCallRoutes,
): string {
  const name = `\`${toolName}\``;
  if (Object.hasOwn(routes.catalogTools, toolName)) {
    return `${name} is a catalog tool, not in your tool list. Call ${EXECUTE_TOOL_NAME} with tool_name ${name} and the same arguments.`;
  }
  if (
    Object.hasOwn(routes.scriptTools, toolName) &&
    routes.modelToolNames.has(CODEMODE_TOOL_NAME)
  ) {
    return `${name} is not in your tool list. Call it in a ${CODEMODE_TOOL_NAME} script as \`tools.${toolName}(args)\` with the same arguments.`;
  }
  const hintText = renderToolNameHint(
    findToolNameHint(toolName, routes.catalogTools),
  );
  const next = hintText
    ? `${hintText} Call a tool in your tool list directly, and any other catalog tool through ${EXECUTE_TOOL_NAME}.`
    : `Call ${SEARCH_TOOLS_NAME} to find its exact name.`;
  return `${name} is not a tool. ${next}`;
}

/** Pi's result text when a direct call names a tool that it does not have. */
function isPiMissingToolResult(message: ToolResultMessage): boolean {
  const [part, ...rest] = message.content;
  return (
    message.isError &&
    rest.length === 0 &&
    part?.type === "text" &&
    part.text === `Tool ${message.toolName} not found`
  );
}

/**
 * Replace Pi's bare "not found" result of each call in `toolResults` that
 * names a tool outside the model tool list with {@link missingToolText}.
 * Return the new history, or undefined when nothing changed.
 *
 * Only results of the newest step change. Earlier results were already sent
 * to the model, so a change to them would break the cached prefix.
 */
export function explainMissingToolResults(
  messages: readonly PiMessage[],
  toolResults: readonly ToolResultMessage[],
  routes: ToolCallRoutes,
): PiMessage[] | undefined {
  const missingCallIds = new Set(
    toolResults
      .filter(
        (result) =>
          !routes.modelToolNames.has(result.toolName) &&
          isPiMissingToolResult(result),
      )
      .map((result) => result.toolCallId),
  );
  if (missingCallIds.size === 0) {
    return undefined;
  }
  return messages.map((message) => {
    if (
      !isToolResultMessage(message) ||
      !missingCallIds.has(message.toolCallId)
    ) {
      return message;
    }
    return {
      ...message,
      content: [
        { type: "text", text: missingToolText(message.toolName, routes) },
      ],
    };
  });
}
