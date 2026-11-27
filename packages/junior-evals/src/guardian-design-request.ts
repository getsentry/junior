/**
 * Build the Guardian request of one design case as core builds it, from the
 * stored records that the case gives (`facts-from-junior` in
 * `design/guardian.md`).
 */
import type { GuardianFactsContext } from "@sentry/junior-plugin-api";
import { pluginGuardianContext } from "@/chat/plugins/guardian-context";
import * as z from "zod";
import { mapBounded } from "@/chat/fan-out";
import type { Action, Message, ReviewRequest } from "@/chat/guardian/guardian";
import type { ToolActionProposal } from "@/chat/guardian/proposal";
import { guardianMessages } from "@/chat/guardian/request";
import { credentialPlaceholders } from "@/chat/guardian/sandbox-facts";
import { getPlugins } from "@/chat/plugins/hooks/registry";
import type { GuardianDesignFacts } from "./guardian-design-harness";
import { designGuardianContext } from "./guardian-facts-context";
import { agentActionFacts, agentHasTool } from "./guardian-tools";
/**
 * The messages of the work, as core builds them. A line of the person from
 * the request that started the work is a message of the root Conversation,
 * which core reads only for a Run of a person: an event Turn gets none. A
 * line from the person's linked account reaches the Turn as an Event, so it
 * is context.
 */
function designMessages(
  proposal: ToolActionProposal,
  facts: GuardianDesignFacts | undefined,
): Message[] {
  const lines = facts?.personLines ?? [];
  const requested = lines.flatMap((line) =>
    line.via === "instruction"
      ? [{ author: "user" as const, text: line.text }]
      : [],
  );
  const root =
    requested.length > 0 && proposal.context.actor.platform !== "system"
      ? {
          messages: [
            ...requested,
            ...(proposal.rootConversation?.messages ?? []),
          ],
          truncated: proposal.rootConversation?.truncated ?? false,
        }
      : proposal.rootConversation;
  return [
    ...guardianMessages({
      ...proposal,
      ...(root ? { rootConversation: root } : undefined),
    }),
    ...lines.flatMap((line) =>
      line.via === "linked-account"
        ? [{ from: "context" as const, text: line.text }]
        : [],
    ),
  ];
}

const mcpArguments = z.record(z.string(), z.unknown()).catch(() => ({}));

/** One action as core builds it, with the facts that its tool gives. */
async function designAction(
  proposal: ToolActionProposal,
  ctx: GuardianFactsContext,
): Promise<Action> {
  const described = await agentActionFacts(proposal.tool, proposal.input, ctx);
  const context = await pluginGuardianContext({
    call: {
      tool: proposal.tool.name,
      input:
        proposal.tool.dispatcherName === "callMcpTool"
          ? mcpArguments.parse(proposal.input["arguments"])
          : proposal.input,
    },
    ctxFor: () => ctx,
  });
  return {
    tool: proposal.tool.name,
    input: proposal.input,
    ...(described.target ? { target: described.target } : undefined),
    ...(described.toolDecision
      ? { toolDecision: described.toolDecision }
      : undefined),
    // Production gives the agent Guardian a remote server's marks.
    ...(proposal.tool.dispatcherName === "callMcpTool" &&
    proposal.tool.annotations
      ? { serverHints: proposal.tool.annotations }
      : undefined),
    ...(context.length > 0 ? { context } : undefined),
    // As production: the summary of the tool's guardian, else the tool
    // name. Only a made-up tool keeps its own description.
    summary:
      described.summary ??
      ((await agentHasTool(proposal.tool))
        ? undefined
        : proposal.tool.proposalDescription) ??
      proposal.tool.name,
  };
}

/** What core adds for a batch with a shell command: the placeholders. */
function designSandbox(
  proposals: readonly ToolActionProposal[],
): ReviewRequest["sandbox"] {
  if (!proposals.some(({ tool }) => tool.name === "bash")) return undefined;
  return {
    placeholders: credentialPlaceholders(
      getPlugins().map((plugin) => plugin.manifest),
    ),
  };
}

/** The Guardian request for the reviewed actions of one case, in order. */
export async function designGuardianRequest(
  proposals: readonly ToolActionProposal[],
  facts: GuardianDesignFacts | undefined,
): Promise<ReviewRequest> {
  const ctx = designGuardianContext(facts);
  const sandbox = designSandbox(proposals);
  return {
    messages: designMessages(proposals[0]!, facts),
    actions: await mapBounded(proposals, async (proposal) =>
      designAction(proposal, ctx),
    ),
    ...(sandbox ? { sandbox } : undefined),
  };
}
