/**
 * Build the Guardian request of one design case as core builds it, plus the
 * facts that the case adds (`facts-from-junior` in `design/guardian.md`).
 */
import { mapBounded } from "@/chat/fan-out";
import type {
  Action,
  Message,
  ReviewRequest,
  Target,
} from "@/chat/guardian/guardian";
import type { ToolActionProposal } from "@/chat/guardian/proposal";
import { guardianMessages } from "@/chat/guardian/request";
import {
  credentialPlaceholders,
  sandboxFacts,
} from "@/chat/guardian/sandbox-facts";
import { getPlugins } from "@/chat/plugins/hooks/registry";
import type {
  GuardianDesignCall,
  GuardianDesignFacts,
  GuardianDesignTarget,
} from "./guardian-design-harness";

function target(fact: GuardianDesignTarget): Target {
  return { ...fact, createdByThisWork: fact.createdByThisWork ?? false };
}

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

/** One action as core builds it, with the case's facts on top. */
function designAction(
  proposal: ToolActionProposal,
  fact: GuardianDesignCall | undefined,
): Action {
  const input = proposal.input as { command?: unknown };
  return {
    tool: proposal.tool.name,
    input: proposal.input,
    effect: fact?.effect ?? "write",
    ...(fact?.target ? { target: target(fact.target) } : undefined),
    summary:
      proposal.tool.name === "bash" && typeof input.command === "string"
        ? input.command
        : (proposal.tool.proposalDescription ?? proposal.tool.name),
  };
}

/**
 * What the Sandbox can reach, for a batch with a shell command. It lists
 * the checkouts of the case, and a repository that the case types keeps
 * its audience.
 */
async function designSandbox(
  proposals: readonly ToolActionProposal[],
  facts: GuardianDesignFacts | undefined,
  indexes: readonly number[],
): Promise<ReviewRequest["sandbox"]> {
  const position = proposals.findIndex(({ tool }) => tool.name === "bash");
  if (position === -1) return undefined;
  const repos = facts?.calls?.[indexes[position]!]?.repos ?? [];
  const sandbox = await sandboxFacts({
    repos: repos.map(({ path, remote }) => ({ path, remote })),
    placeholders: credentialPlaceholders(
      getPlugins().map((plugin) => plugin.manifest),
    ),
  });
  return {
    ...sandbox,
    repos: sandbox.repos.map((repo, index) => {
      const typed = repos[index]?.target;
      return typed
        ? { ...repo, target: { ref: typed.ref, audience: typed.audience } }
        : repo;
    }),
  };
}

/** The Guardian request for the reviewed actions of one case, in order. */
export async function designGuardianRequest(
  proposals: readonly ToolActionProposal[],
  facts: GuardianDesignFacts | undefined,
  /** The index of each proposal in the case, for its call facts. */
  indexes: readonly number[],
): Promise<ReviewRequest> {
  const sandbox = await designSandbox(proposals, facts, indexes);
  return {
    messages: designMessages(proposals[0]!, facts),
    actions: await mapBounded(proposals, async (proposal, position) =>
      designAction(proposal, facts?.calls?.[indexes[position]!]),
    ),
    ...(sandbox ? { sandbox } : undefined),
  };
}
