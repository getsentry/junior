/**
 * Build the Guardian request of one design case as core builds it, from the
 * stored records that the case gives (`facts-from-junior` in
 * `design/guardian.md`).
 */
import { posix } from "node:path";
import type { GuardianContext } from "@sentry/junior-plugin-api";
import { mapBounded } from "@/chat/fan-out";
import { actionFromGuardian } from "@/chat/guardian/call-facts";
import { repositoryUrlKey } from "@/chat/guardian/checkout-records";
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
  gitCommandFacts,
  sandboxFacts,
} from "@/chat/guardian/sandbox-facts";
import { getPlugins } from "@/chat/plugins/hooks/registry";
import { SANDBOX_WORKSPACE_ROOT } from "@/chat/sandbox/paths";
import type {
  GuardianDesignCheckout,
  GuardianDesignFacts,
} from "./guardian-design-harness";
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
): GuardianContext {
  const privateRepos = new Set(
    (facts?.privateRepos ?? []).map((repo) => repo.toLowerCase()),
  );
  const own = new Set(facts?.ownPullRequests ?? []);
  return {
    cache: memoryCache(),
    codeChanges: {
      async list({ repository }) {
        const owned = (repository?.numbers ?? []).some((number) =>
          own.has(`${repository?.name}#${number}`),
        );
        return owned ? [{} as never] : [];
      },
    },
    async conversationIds() {
      return ["guardian-eval"];
    },
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

/** One action as core builds it, with the facts that its tool gives. */
async function designAction(
  proposal: ToolActionProposal,
  ctx: GuardianContext,
): Promise<Action> {
  const input = proposal.input as { command?: unknown };
  const described = await agentActionFacts(proposal.tool, proposal.input, ctx);
  return {
    tool: proposal.tool.name,
    input: proposal.input,
    ...(described.target ? { target: described.target } : undefined),
    ...(described.toolDecision
      ? { toolDecision: described.toolDecision }
      : undefined),
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
  ctx: GuardianContext,
): Promise<ReviewRequest["sandbox"]> {
  const commands = proposals.filter(({ tool }) => tool.name === "bash");
  if (commands.length === 0) return undefined;
  const checkouts = facts?.checkouts ?? [];
  const git = commands.map(({ input }) => gitCommandFacts(input));
  // Core lists the checkouts under the root, and those that hold a
  // directory that a command runs in.
  const dirs = git.flatMap((facts) =>
    facts.dirs.map((dir) => posix.resolve(SANDBOX_WORKSPACE_ROOT, dir)),
  );
  const listed = checkouts.filter(
    ({ path }) =>
      [SANDBOX_WORKSPACE_ROOT, `${SANDBOX_WORKSPACE_ROOT}/repos`].includes(
        posix.dirname(path),
      ) || dirs.some((dir) => dir === path || dir.startsWith(`${path}/`)),
  );
  return await sandboxFacts({
    repos: listed.map(({ path, remotes }) => ({ path, remotes })),
    urls: git.flatMap((facts) => facts.urls),
    placeholders: credentialPlaceholders(
      getPlugins().map((plugin) => plugin.manifest),
    ),
    ...(git.some((facts) => facts.pushes)
      ? {
          unpushed: async (path: string) =>
            checkouts.find((checkout) => checkout.path === path)?.unpushed ??
            "",
        }
      : undefined),
    targets: await workspaceTargets(checkouts, ctx),
  });
}

/**
 * The clone records of the case's Sandbox. Each checkout is the Workspace
 * checkout of its first remote, which the GitHub plugin describes, as core
 * reads it at push time. Other remotes have no record.
 */
async function workspaceTargets(
  checkouts: readonly GuardianDesignCheckout[],
  ctx: GuardianContext,
): Promise<Map<string, Target>> {
  const github = getPlugins().find(
    (plugin) => plugin.manifest.name === "github",
  );
  const described = await mapBounded(checkouts, async ({ remotes }) => {
    const repo = /^https:\/\/github\.com\/([^/]+\/[^/]+?)\.git$/.exec(
      remotes[0] ?? "",
    )?.[1];
    const result = repo
      ? await github?.hooks?.guardian?.(
          { kind: "workspaceCheckout", repo },
          ctx,
        )
      : undefined;
    return result ? actionFromGuardian(result).target : undefined;
  });
  const targets = new Map<string, Target>();
  for (const target of described) {
    const key = target && repositoryUrlKey(target.ref);
    if (target && key) targets.set(key, target);
  }
  return targets;
}

/** The Guardian request for the reviewed actions of one case, in order. */
export async function designGuardianRequest(
  proposals: readonly ToolActionProposal[],
  facts: GuardianDesignFacts | undefined,
): Promise<ReviewRequest> {
  const ctx = designGuardianContext(facts);
  const sandbox = await designSandbox(proposals, facts, ctx);
  return {
    messages: designMessages(proposals[0]!, facts),
    actions: await mapBounded(proposals, async (proposal) =>
      designAction(proposal, ctx),
    ),
    ...(sandbox ? { sandbox } : undefined),
  };
}
