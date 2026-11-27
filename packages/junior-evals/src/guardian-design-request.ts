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
 * The messages of the work. A line of the person that reaches the Turn
 * from the request that started the work comes before the Conversation, and
 * one from the person's linked account comes after it.
 */
function designMessages(
  proposal: ToolActionProposal,
  facts: GuardianDesignFacts | undefined,
): Message[] {
  const lines = (via: "instruction" | "linked-account"): Message[] =>
    (facts?.personLines ?? [])
      .filter((line) => line.via === via)
      .map((line) => ({ from: "instruction", text: line.text }));
  return [
    ...lines("instruction"),
    ...guardianMessages(proposal),
    ...lines("linked-account"),
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
    ...(proposal.tool.serverHints
      ? { serverHints: proposal.tool.serverHints }
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
