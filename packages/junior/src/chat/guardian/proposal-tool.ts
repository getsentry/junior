/**
 * The `tool` field of a proposal and the current Guardian's line for it.
 */
import type {
  ActionDescription,
  AnyToolDefinition,
  ToolApprovalResolution,
} from "@/chat/tool-support/definition";
import type { ToolActionProposal } from "@/chat/guardian/proposal";

/**
 * The current Guardian's line for one call: the summary of the tool's
 * `guardian`, as main's `describeProposal` gave it. Other calls get no line,
 * as on main.
 */
export function describedProposal(
  described: ActionDescription | undefined,
): string | undefined {
  return described?.summary;
}

/** Cut the middle of `text` so it fits in `maxChars`. */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half)}\n[truncated]\n${text.slice(-half)}`;
}

/**
 * Build the `tool` field of a proposal: the tool as Guardian sees it for this
 * input. The resolved metadata of a dispatcher, such as `callMcpTool`, names
 * the real tool. The Guardian evals call this with the agent's own tools, so
 * they send the same shape as production.
 */
export function proposalTool(
  toolName: string,
  tool: AnyToolDefinition,
  resolved: ToolApprovalResolution | undefined,
  /** The line from `describedProposal`, when the call has one. */
  proposalDescription: string | undefined,
): ToolActionProposal["tool"] {
  const name = resolved?.name ?? toolName;
  const annotations = resolved?.serverHints ?? tool.annotations;
  const catalogSource = resolved?.source ?? tool.source;
  return {
    // The current Guardian reads a remote server's marks as `annotations`.
    ...(annotations ? { annotations } : undefined),
    description: resolved?.description ?? tool.description,
    ...(name !== toolName ? { dispatcherName: toolName } : undefined),
    ...(tool.identity ? { identity: tool.identity } : undefined),
    name,
    ...(proposalDescription ? { proposalDescription } : undefined),
    ...(catalogSource ? { catalogSource } : undefined),
  };
}
