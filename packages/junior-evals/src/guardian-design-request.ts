/**
 * Build the Guardian request of one design case as core builds it, from the
 * stored records that the case gives (`facts-from-junior` in
 * `design/guardian.md`).
 */
import type { DescribeReadContext } from "@sentry/junior-plugin-api";
import { mapBounded } from "@/chat/fan-out";
import type { Action, Message, ReviewRequest } from "@/chat/guardian/guardian";
import type { ToolActionProposal } from "@/chat/guardian/proposal";
import { guardianMessages } from "@/chat/guardian/request";
import {
  credentialPlaceholders,
  isGitPush,
  sandboxFacts,
} from "@/chat/guardian/sandbox-facts";
import { getPlugins } from "@/chat/plugins/hooks/registry";
import type { GuardianDesignFacts } from "./guardian-design-harness";
import { agentActionFacts } from "./guardian-tools";
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

/** A plugin cache in memory, for the reads of one request. */
function memoryCache(): DescribeReadContext["cache"] {
  const entries = new Map<string, unknown>();
  return {
    async get<T>(key: string) {
      return entries.get(key) as T | undefined;
    },
    async getOrLoad<T>(key: string, load: () => Promise<{ value: T }>) {
      if (!entries.has(key)) entries.set(key, (await load()).value);
      return entries.get(key) as T;
    },
    async update<T>(
      key: string,
      next: (current: T | undefined) => { value: T } | undefined,
    ) {
      const entry = next(entries.get(key) as T | undefined);
      if (entry) entries.set(key, entry.value);
    },
    async delete(key: string) {
      entries.delete(key);
    },
  };
}

/**
 * What a plugin reads while it describes a call, as production gives it.
 * GitHub answers a repository read with the case's visibility. Every other
 * provider read fails, as when a provider does not answer.
 */
function designReadContext(
  facts: GuardianDesignFacts | undefined,
): DescribeReadContext {
  const privateRepos = new Set(
    (facts?.privateRepos ?? []).map((repo) => repo.toLowerCase()),
  );
  return {
    cache: memoryCache(),
    egress: {
      async fetch({ request }) {
        const url = new URL(request.url);
        const repo = /^\/repos\/([^/]+\/[^/]+)$/.exec(url.pathname)?.[1];
        if (url.hostname !== "api.github.com" || !repo) {
          return Response.json({ message: "Not Found" }, { status: 404 });
        }
        return Response.json({
          private: privateRepos.has(decodeURIComponent(repo).toLowerCase()),
        });
      },
    },
  };
}

/** One action as core builds it, with the facts that its tool describes. */
async function designAction(
  proposal: ToolActionProposal,
  facts: GuardianDesignFacts | undefined,
  readContext: DescribeReadContext,
): Promise<Action> {
  const input = proposal.input as { command?: unknown };
  const described = await agentActionFacts(proposal.tool, proposal.input, {
    ownPullRequests: facts?.ownPullRequests ?? [],
    readContext,
  });
  return {
    tool: proposal.tool.name,
    input: proposal.input,
    ...(described.target ? { target: described.target } : undefined),
    ...(described.advice ? { advice: described.advice } : undefined),
    summary:
      proposal.tool.name === "bash" && typeof input.command === "string"
        ? input.command
        : (described.summary ??
          proposal.tool.proposalDescription ??
          proposal.tool.name),
  };
}

/**
 * What the Sandbox can reach, for a batch with a shell command, as the gate
 * reads it: the case's checkouts, and their unpushed commits for a push.
 */
async function designSandbox(
  proposals: readonly ToolActionProposal[],
  facts: GuardianDesignFacts | undefined,
  readContext: DescribeReadContext,
): Promise<ReviewRequest["sandbox"]> {
  const commands = proposals.filter(({ tool }) => tool.name === "bash");
  if (commands.length === 0) return undefined;
  const checkouts = facts?.checkouts ?? [];
  const pushes = commands.some(({ input }) => isGitPush(input));
  return await sandboxFacts({
    repos: checkouts.map(({ path, remote }) => ({ path, remote })),
    placeholders: credentialPlaceholders(
      getPlugins().map((plugin) => plugin.manifest),
    ),
    ...(pushes
      ? {
          unpushed: async (path: string) =>
            checkouts.find((checkout) => checkout.path === path)?.unpushed ??
            "",
        }
      : undefined),
    readContext: () => readContext,
  });
}

/** The Guardian request for the reviewed actions of one case, in order. */
export async function designGuardianRequest(
  proposals: readonly ToolActionProposal[],
  facts: GuardianDesignFacts | undefined,
): Promise<ReviewRequest> {
  const readContext = designReadContext(facts);
  const sandbox = await designSandbox(proposals, facts, readContext);
  return {
    messages: designMessages(proposals[0]!, facts),
    actions: await mapBounded(proposals, async (proposal) =>
      designAction(proposal, facts, readContext),
    ),
    ...(sandbox ? { sandbox } : undefined),
  };
}
