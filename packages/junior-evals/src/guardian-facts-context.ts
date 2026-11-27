/**
 * What a plugin's `guardian` reads in the Guardian evals, as production
 * gives it, from the facts that a case states.
 */
import type {
  CodeChange,
  GuardianContext,
  GuardianFactsContext,
} from "@sentry/junior-plugin-api";
import type { GuardianDesignFacts } from "./guardian-design-harness";

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
export function designGuardianContext(
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
