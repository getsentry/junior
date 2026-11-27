/**
 * Build the Guardian request of one design case as core builds it, from the
 * stored records that the case gives (`facts-from-junior` in
 * `design/guardian.md`).
 */
import type {
  CodeChange,
  GuardianContext,
  GuardianFactsContext,
} from "@sentry/junior-plugin-api";
import { pluginGuardianContext } from "@/chat/plugins/guardian-context";
import * as z from "zod";
import { mapBounded } from "@/chat/fan-out";
import type { Action, Message, ReviewRequest } from "@/chat/guardian/guardian";
import type { ToolActionProposal } from "@/chat/guardian/proposal";
import { guardianMessages } from "@/chat/guardian/request";
import { credentialPlaceholders } from "@/chat/guardian/sandbox-facts";
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
function memoryCache(): GuardianContext["cache"] {
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
 * What a plugin's `guardian` reads, as production gives it. GitHub answers a
 * repository read with the case's visibility. Every other provider read
 * fails, as when a provider does not answer. The code-change records hold
 * the case's own pull requests.
 */
function designGuardianContext(
  facts: GuardianDesignFacts | undefined,
): GuardianFactsContext {
  const privateRepos = new Set(
    (facts?.privateRepos ?? []).map((repo) => repo.toLowerCase()),
  );
  const own = new Set(facts?.ownPullRequests ?? []);
  return {
    cache: memoryCache(),
    codeChanges: {
      async list({ repository }) {
        if (!repository) {
          return [...own].map((ref): CodeChange => {
            const [name = ref, number] = ref.split("#");
            return {
              closedAt: undefined,
              conversationIds: [],
              mergedAt: undefined,
              number: Number(number),
              providerId: ref,
              repository: { name, providerId: name },
              state: "open",
            };
          });
        }
        const owned = (repository.numbers ?? []).some((number) =>
          own.has(`${repository.name}#${number}`),
        );
        return owned ? [{} as never] : [];
      },
    },
    async workspaceRepos() {
      return (facts?.workspaceRepos ?? []).map((repo) => ({
        provider: "github",
        repo,
      }));
    },
    async conversationIds() {
      return ["guardian-eval"];
    },
    egress: {
      async fetch({ request }) {
        const url = new URL(request.url);
        const pull = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(
          url.pathname,
        );
        const branch =
          pull &&
          facts?.pullRequestBranches?.[
            `${decodeURIComponent(pull[1]!)}#${pull[2]}`
          ];
        if (url.hostname === "api.github.com" && branch) {
          return Response.json({ head: { ref: branch } });
        }
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

const mcpArguments = z.record(z.string(), z.unknown()).catch({});

/** One action as core builds it, with the facts that its tool gives. */
async function designAction(
  proposal: ToolActionProposal,
  ctx: GuardianFactsContext,
): Promise<Action> {
  const input = proposal.input as { command?: unknown };
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
    summary:
      proposal.tool.name === "bash" && typeof input.command === "string"
        ? input.command
        : (described.summary ??
          proposal.tool.proposalDescription ??
          proposal.tool.name),
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
