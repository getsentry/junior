/**
 * Build the Guardian request of one design case as core builds it, plus the
 * facts that the case adds (`facts-from-junior` in `design/guardian.md`).
 */
import {
  commandCall,
  credentialPlaceholders,
} from "@/chat/guardian/command-call";
import type {
  Call,
  Message,
  ReviewRequest,
  Target,
} from "@/chat/guardian/guardian";
import { mapBounded } from "@/chat/fan-out";
import type { ToolActionProposal } from "@/chat/guardian/proposal";
import { defaultCall, guardianMessages } from "@/chat/guardian/request";
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

/**
 * The call of one action as core builds it, with the case's facts on top.
 * A shell command lists the checkouts of the case, and a repository that
 * the case types keeps its audience.
 */
async function designCall(
  proposal: ToolActionProposal,
  fact: GuardianDesignCall | undefined,
): Promise<Call> {
  if (proposal.tool.name === "bash") {
    const command = await commandCall({
      input: proposal.input,
      repos: (fact?.repos ?? []).map(({ path, remote }) => ({ path, remote })),
      placeholders: credentialPlaceholders(
        getPlugins().map((plugin) => plugin.manifest),
      ),
    });
    return {
      ...command,
      repos: command.repos.map((repo, index) => {
        const typed = fact?.repos?.[index]?.target;
        return typed ? { ...repo, target: target(typed) } : repo;
      }),
    };
  }
  const call = defaultCall(proposal.tool.annotations, proposal.tool.name);
  return {
    ...call,
    ...(fact?.effect ? { effect: fact.effect } : undefined),
    ...(fact?.target ? { target: target(fact.target) } : undefined),
  };
}

/** The Guardian request for the reviewed actions of one case, in order. */
export async function designGuardianRequest(
  proposals: readonly ToolActionProposal[],
  facts: GuardianDesignFacts | undefined,
  /** The index of each proposal in the case, for its call facts. */
  indexes: readonly number[],
): Promise<ReviewRequest> {
  const script = proposals.find((proposal) => proposal.script)?.script;
  return {
    messages: designMessages(proposals[0]!, facts),
    actions: await mapBounded(proposals, async (proposal, position) => ({
      tool: proposal.tool.name,
      call: await designCall(proposal, facts?.calls?.[indexes[position]!]),
      input: proposal.input,
      permission: "review" as const,
    })),
    ...(script ? { script: script.source } : undefined),
  };
}
