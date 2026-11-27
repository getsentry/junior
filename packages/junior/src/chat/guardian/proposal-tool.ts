/**
 * The `tool` field of a proposal and the current Guardian's line for it.
 */
import type {
  ActionDescription,
  AnyToolDefinition,
  ToolApprovalResolution,
} from "@/chat/tool-support/definition";
import type { ToolActionProposal } from "@/chat/guardian/proposal";

const MAX_PROPOSAL_DESCRIPTION_CHARS = 300;

/**
 * The current Guardian's line for one call: the summary of the tool's
 * `guardian`, else its target with the reason label, else the tool name and
 * a short rendering of the input.
 */
export function describedProposal(
  described: ActionDescription | undefined,
  toolName: string,
  input: Record<string, unknown>,
): string {
  if (described?.summary) {
    return described.summary;
  }
  if (described?.target) {
    const reason = described.toolDecision?.reason;
    return reason
      ? `${described.target.ref} (${reason})`
      : described.target.ref;
  }
  return truncateMiddle(
    `${toolName} ${JSON.stringify(input)}`,
    MAX_PROPOSAL_DESCRIPTION_CHARS,
  );
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
  const catalogSource = resolved?.source ?? tool.source;
  return {
    // A dispatcher's own marks say nothing about the real tool.
    ...(resolved?.serverHints
      ? { serverHints: resolved.serverHints }
      : !resolved && tool.annotations
        ? { annotations: tool.annotations }
        : undefined),
    description: resolved?.description ?? tool.description,
    ...(name !== toolName ? { dispatcherName: toolName } : undefined),
    ...(tool.identity ? { identity: tool.identity } : undefined),
    name,
    ...(proposalDescription ? { proposalDescription } : undefined),
    ...(catalogSource ? { catalogSource } : undefined),
  };
}
