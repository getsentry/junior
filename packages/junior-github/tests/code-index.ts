import {
  type CodeChange,
  codeChangeFilterSchema,
  type CodeChangeInput,
  codeChangeInputSchema,
  type PluginCodeChanges,
} from "@sentry/junior-plugin-api";
import {
  type GitHubPullRequestState,
  juniorGitHubPullRequests,
} from "../src/db/schema";
import type { GitHubFixture } from "./github-db";

type StoredChange = CodeChange & { updatedAt: Date };

/**
 * Junior's code index in memory, for the GitHub plugin. Core owns the real
 * one (`packages/junior/src/chat/code/store.ts`). This keeps the rules that
 * the plugin relies on: an older update does not move a code change back,
 * Conversation links and requesters only grow, requesters need a recorded
 * code change, and a read matches the repository name in
 * any case. Reads list the oldest update first, then by provider id, so
 * tests see one order.
 */
export function memoryCodeIndex() {
  const changes = new Map<string, StoredChange>();
  /** Every code change that the plugin recorded, in order. */
  const recorded: CodeChangeInput[] = [];
  const link = (stored: StoredChange, conversationIds: string[]) => {
    stored.conversationIds = [
      ...new Set([...stored.conversationIds, ...conversationIds]),
    ].sort();
  };
  const store = (input: CodeChangeInput) => {
    const change = codeChangeInputSchema.parse(input);
    const stored = changes.get(change.providerId);
    if (stored && stored.updatedAt > change.updatedAt) return;
    const next: StoredChange = {
      closedAt: change.closedAt,
      conversationIds: stored?.conversationIds ?? [],
      mergedAt: change.mergedAt,
      number: change.number,
      providerId: change.providerId,
      repository: {
        name: change.repository.name,
        providerId: change.repository.providerId,
      },
      state: change.state,
      updatedAt: change.updatedAt,
    };
    link(next, change.conversationIds);
    changes.set(change.providerId, next);
  };
  /** Requester identity ids of each code change, by provider id. */
  const requesters = new Map<string, string[]>();
  const codeChanges: PluginCodeChanges = {
    async associateConversations(input) {
      const stored = changes.get(input.providerId);
      if (stored) link(stored, input.conversationIds);
    },
    async associateRequesters(input) {
      if (!changes.has(input.providerId)) return;
      requesters.set(
        input.providerId,
        [
          ...new Set([
            ...(requesters.get(input.providerId) ?? []),
            ...input.identityIds,
          ]),
        ].sort(),
      );
    },
    async list(input) {
      const filter = codeChangeFilterSchema.parse(input);
      const conversationIds = new Set(filter.conversationIds);
      const providerIds = new Set(filter.providerIds);
      return [...changes.values()]
        .filter(
          (change) =>
            (!filter.conversationIds ||
              change.conversationIds.some((id) => conversationIds.has(id))) &&
            (!filter.providerIds || providerIds.has(change.providerId)) &&
            (!filter.repository ||
              (change.repository.name.toLowerCase() ===
                filter.repository.name.toLowerCase() &&
                (!filter.repository.numbers ||
                  filter.repository.numbers.includes(change.number)))) &&
            (!filter.state || change.state === filter.state) &&
            (!filter.updatedBefore || change.updatedAt < filter.updatedBefore),
        )
        .sort(
          (a, b) =>
            a.updatedAt.getTime() - b.updatedAt.getTime() ||
            a.providerId.localeCompare(b.providerId),
        )
        .map(({ updatedAt: _updatedAt, ...change }) => structuredClone(change));
    },
    async record(input) {
      recorded.push(input);
      store(input);
    },
    async recordActivity() {},
    async recordRepository(input) {
      for (const change of changes.values()) {
        if (change.repository.providerId === input.providerId) {
          change.repository.name = input.name;
        }
      }
    },
  };
  return {
    codeChanges,
    /** The code changes in the index now, oldest update first. */
    async changes(): Promise<CodeChange[]> {
      return await codeChanges.list({});
    },
    recorded,
    /** The requesters that the index credits on one code change. */
    requesters: (providerId: string) => requesters.get(providerId) ?? [],
    /** Add a code change that the plugin recorded before the test. */
    seed: store,
  };
}

export type MemoryCodeIndex = ReturnType<typeof memoryCodeIndex>;

/**
 * Seed one Junior pull request that GitHub opened before the test: the
 * plugin's row and the code change in Junior's code index.
 */
export async function recordJuniorPullRequest(
  fixture: GitHubFixture,
  input: Partial<typeof juniorGitHubPullRequests.$inferInsert> & {
    conversationIds?: string[];
    finishedAt?: Date;
    number: number;
    openedAt?: Date;
    repositoryFullName?: string;
    repositoryId?: string;
    state?: GitHubPullRequestState;
    updatedAt: Date;
  },
): Promise<void> {
  const {
    conversationIds = [],
    finishedAt,
    number,
    openedAt = input.updatedAt,
    pullRequestId = `${input.number}0`,
    repositoryFullName = "getsentry/junior",
    repositoryId = "1",
    state = "open",
    ...row
  } = input;
  await fixture
    .db()
    .insert(juniorGitHubPullRequests)
    .values({ ...row, pullRequestId });
  fixture.codeIndex.seed({
    closedAt: state === "open" ? undefined : finishedAt,
    conversationIds,
    mergedAt: state === "merged" ? finishedAt : undefined,
    number,
    openedAt,
    providerId: pullRequestId,
    repository: { name: repositoryFullName, providerId: repositoryId },
    state: state === "closed_unmerged" ? "closed" : state,
    updatedAt: input.updatedAt,
  });
}
