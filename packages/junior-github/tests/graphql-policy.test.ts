import type {
  PluginCache,
  PluginGraphqlField,
  PluginGraphqlOperation,
  PluginGraphqlRequest,
  PluginGraphqlUnreadableReason,
} from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { githubPlugin } from "../src/index";

const GRAPHQL_URL = "https://api.github.com/graphql";
const MUTATIONS_DISABLED = "GraphQL mutations are not enabled";

function operation(
  type: PluginGraphqlOperation["type"],
  rootFields: string[],
  input?: { fields?: PluginGraphqlField[]; name?: string },
): PluginGraphqlOperation {
  return {
    fields:
      input?.fields ?? rootFields.map((name) => ({ arguments: [], name })),
    ...(input?.name ? { name: input.name } : undefined),
    rootFields,
    type,
  };
}

function single(op: PluginGraphqlOperation): PluginGraphqlRequest {
  return { kind: "operation", operation: op };
}

function unreadable(
  reason: PluginGraphqlUnreadableReason,
): PluginGraphqlRequest {
  return { kind: "unreadable", reason };
}

function memoryCache(): PluginCache {
  const values = new Map<string, unknown>();
  return {
    async get<T>(key: string) {
      return values.get(key) as T | undefined;
    },
    async getOrLoad<T>(key: string, load: () => Promise<{ value: T }>) {
      return (await load()).value;
    },
    async update<T>(
      key: string,
      next: (current: T | undefined) => { value: T } | undefined,
    ) {
      const entry = next(values.get(key) as T | undefined);
      if (entry) values.set(key, entry.value);
    },
    async delete(key: string) {
      values.delete(key);
    },
  };
}

async function grantForGraphql(input: {
  cache?: PluginCache;
  conversationId?: string;
  graphql?: PluginGraphqlRequest;
  method?: string;
  operation?: string;
}) {
  return await githubPlugin().hooks?.grantForEgress?.({
    cache: input.cache ?? memoryCache(),
    db: undefined,
    log: { error() {}, info() {}, warn() {} },
    plugin: { name: "github" },
    request: {
      ...(input.conversationId
        ? { conversationId: input.conversationId }
        : undefined),
      ...(input.graphql ? { graphql: input.graphql } : undefined),
      method: input.method ?? "POST",
      ...(input.operation ? { operation: input.operation } : undefined),
      url: GRAPHQL_URL,
    },
  });
}

// Send a GraphQL response with GitHub's rate limit headers through the
// plugin's response hook, as egress does after each upstream request.
async function respondToGraphql(input: {
  cache: PluginCache;
  conversationId?: string;
  operation?: string;
  remaining: number;
  resetAtMs: number;
  used: number;
}) {
  await githubPlugin().hooks?.onEgressResponse?.({
    cache: input.cache,
    db: undefined,
    grant: { access: "read", name: "installation-read", reason: "test" },
    log: { error() {}, info() {}, warn() {} },
    permissionDenied() {},
    plugin: { name: "github" },
    request: {
      ...(input.conversationId
        ? { conversationId: input.conversationId }
        : undefined),
      method: "POST",
      ...(input.operation ? { operation: input.operation } : undefined),
      url: GRAPHQL_URL,
    },
    response: {
      headers: new Headers({
        "x-ratelimit-remaining": String(input.remaining),
        "x-ratelimit-reset": String(input.resetAtMs / 1000),
        "x-ratelimit-resource": "graphql",
        "x-ratelimit-used": String(input.used),
      }),
      async readText() {
        return undefined;
      },
      status: 200,
    },
  });
}

const HOST_MUTATIONS = [
  [
    "ResolveReviewThread",
    "resolveReviewThread",
    "github.pull.review-thread.resolve:",
  ],
  [
    "MarkPullRequestReadyForReview",
    "markPullRequestReadyForReview",
    "github.pull.draft.update:",
  ],
  [
    "ConvertPullRequestToDraft",
    "convertPullRequestToDraft",
    "github.pull.draft.update:",
  ],
  ["AddReviewReaction", "addReaction", "github.pull.review-reaction.update:"],
  [
    "RemoveReviewReaction",
    "removeReaction",
    "github.pull.review-reaction.update:",
  ],
] as const;

describe("GitHub GraphQL policy", () => {
  it("reads GraphQL GETs and queries with the installation", async () => {
    for (const request of [
      { method: "GET" },
      { graphql: single(operation("query", ["repository"], { name: "List" })) },
      { graphql: single(operation("query", ["viewer"])) },
    ]) {
      await expect(grantForGraphql(request)).resolves.toMatchObject({
        name: "installation-read",
        access: "read",
        reason: "github.graphql-read",
      });
    }
  });

  it.each(HOST_MUTATIONS)(
    "allows the typed %s mutation only from its host tool",
    async (name, field, operationPrefix) => {
      const graphql = single(operation("mutation", [field], { name }));
      await expect(
        grantForGraphql({
          graphql,
          operation: `${operationPrefix}getsentry/junior`,
        }),
      ).resolves.toMatchObject({
        name: "installation-write",
        access: "write",
        reason: "github.installation-write",
        auditAttributes: { "app.github.repository": "getsentry/junior" },
      });
      await expect(grantForGraphql({ graphql })).rejects.toThrow(
        MUTATIONS_DISABLED,
      );
      await expect(
        grantForGraphql({
          graphql,
          operation: "github.issue.comment.create:getsentry/junior",
        }),
      ).rejects.toThrow(MUTATIONS_DISABLED);
    },
  );

  it.each([
    [
      "a different mutation",
      single(
        operation("mutation", ["addComment"], { name: "AddIssueComment" }),
      ),
    ],
    [
      // `mutation ResolveReviewThread { resolveReviewThread: addComment(...) }`
      "an aliased mutation",
      single(
        operation("mutation", ["addComment"], { name: "ResolveReviewThread" }),
      ),
    ],
    [
      "a second root field",
      single(
        operation("mutation", ["resolveReviewThread", "addComment"], {
          name: "ResolveReviewThread",
        }),
      ),
    ],
    [
      "a batch",
      {
        kind: "batch",
        operations: [
          operation("mutation", ["resolveReviewThread"], {
            name: "ResolveReviewThread",
          }),
        ],
      },
    ],
    ["an unreadable body", unreadable("document")],
  ] satisfies [string, PluginGraphqlRequest][])(
    "denies %s from a host tool",
    async (_name, graphql) => {
      await expect(
        grantForGraphql({
          graphql,
          operation: "github.pull.review-thread.resolve:getsentry/junior",
        }),
      ).rejects.toThrow(MUTATIONS_DISABLED);
    },
  );

  it.each([
    ["createIssue", "must use the github_createIssue tool"],
    ["createPullRequest", "must use the github_createPullRequest tool"],
    [
      "addPullRequestReview",
      "must use the github_submitPullRequestReview tool",
    ],
    [
      "addPullRequestReviewThreadReply",
      "must use the github_commentOnPullRequest tool",
    ],
    ["updateIssue", "must use the github_updateIssue tool"],
    ["updatePullRequest", "must use the github_updatePullRequest tool"],
  ])("routes the %s mutation to its typed tool", async (field, message) => {
    await expect(
      grantForGraphql({
        graphql: single(operation("mutation", [field], { name: "Write" })),
      }),
    ).rejects.toThrow(message);
  });

  it("denies other mutations and subscriptions", async () => {
    for (const op of [
      operation("mutation", ["addComment"]),
      operation("subscription", ["events"]),
    ]) {
      await expect(grantForGraphql({ graphql: single(op) })).rejects.toThrow(
        MUTATIONS_DISABLED,
      );
    }
  });

  it("denies batches, even of queries", async () => {
    await expect(
      grantForGraphql({
        graphql: {
          kind: "batch",
          operations: [operation("query", ["viewer"])],
        },
      }),
    ).rejects.toThrow(MUTATIONS_DISABLED);
  });

  it.each(["document", "gzip", "json", "operation", "query"] as const)(
    "denies a %s-unreadable body as a mutation",
    async (reason) => {
      await expect(
        grantForGraphql({ graphql: unreadable(reason) }),
      ).rejects.toThrow(MUTATIONS_DISABLED);
    },
  );

  it("denies a POST that the host did not read", async () => {
    await expect(grantForGraphql({})).rejects.toThrow(MUTATIONS_DISABLED);
  });

  it("denies a body too large to read", async () => {
    await expect(
      grantForGraphql({
        graphql: unreadable("too-large"),
        operation: "github.pull.review-thread.resolve:getsentry/junior",
      }),
    ).rejects.toThrow(
      "GitHub GraphQL request body is too large to inspect before issuing credentials.",
    );
  });

  it("routes GraphQL issue reads to github_getIssue", async () => {
    const issueRead = single(
      operation("query", ["repository"], {
        fields: [
          { arguments: ["owner", "name"], name: "repository" },
          { arguments: ["number"], name: "issueOrPullRequest" },
        ],
      }),
    );
    await expect(grantForGraphql({ graphql: issueRead })).rejects.toThrow(
      "Use github_getIssue",
    );
    // An `issue` field without arguments, such as `IssueComment.issue`,
    // reads no single issue by number.
    await expect(
      grantForGraphql({
        graphql: single(
          operation("query", ["node"], {
            fields: [
              { arguments: ["id"], name: "node" },
              { arguments: [], name: "issue" },
            ],
          }),
        ),
      }),
    ).resolves.toMatchObject({ access: "read" });
    await expect(
      grantForGraphql({
        graphql: single(
          operation("query", ["repository"], {
            fields: [
              { arguments: ["owner", "name"], name: "repository" },
              { arguments: ["first"], name: "issues" },
            ],
          }),
        ),
      }),
    ).resolves.toMatchObject({ access: "read" });
  });

  describe("Sandbox budget", () => {
    const query = single(operation("query", ["viewer"]));
    const resetAtMs = Date.parse("2026-11-25T10:40:00Z");

    afterEach(() => {
      vi.useRealTimers();
    });

    it("denies a Conversation's queries once GitHub has charged its hourly budget", async () => {
      vi.useFakeTimers({ now: new Date("2026-11-25T10:15:00Z") });
      const cache = memoryCache();
      // The first response in a window sets the baseline. The next one
      // charges what `x-ratelimit-used` rose by.
      await respondToGraphql({
        cache,
        conversationId: "c1",
        remaining: 11_500,
        resetAtMs,
        used: 1_000,
      });
      await respondToGraphql({
        cache,
        conversationId: "c1",
        remaining: 9_502,
        resetAtMs,
        used: 2_998,
      });
      // A host call spends installation points, not the Conversation's.
      await respondToGraphql({
        cache,
        conversationId: "c1",
        operation: "github.pull.get",
        remaining: 9_452,
        resetAtMs,
        used: 3_048,
      });
      await expect(
        grantForGraphql({ cache, conversationId: "c1", graphql: query }),
      ).resolves.toMatchObject({ access: "read" });
      await respondToGraphql({
        cache,
        conversationId: "c1",
        remaining: 9_450,
        resetAtMs,
        used: 3_050,
      });

      await expect(
        grantForGraphql({ cache, conversationId: "c1", graphql: query }),
      ).rejects.toThrow(
        "this Conversation has used 2001 of its 2000 Sandbox GraphQL points for this hour. The budget resets at 11:00 UTC (in 45 min).",
      );
      await expect(
        grantForGraphql({ cache, conversationId: "c2", graphql: query }),
      ).resolves.toMatchObject({ access: "read" });
      vi.setSystemTime(new Date("2026-11-25T11:00:00Z"));
      await expect(
        grantForGraphql({ cache, conversationId: "c1", graphql: query }),
      ).resolves.toMatchObject({ access: "read" });
    });

    it("keeps the host reserve of the installation's budget until it resets", async () => {
      vi.useFakeTimers({ now: new Date("2026-11-25T10:15:00Z") });
      const cache = memoryCache();
      await respondToGraphql({
        cache,
        operation: "github.pull.get",
        remaining: 2_000,
        resetAtMs,
        used: 3_000,
      });

      await expect(
        grantForGraphql({ cache, conversationId: "c1", graphql: query }),
      ).rejects.toThrow(
        "the App installation has 2000 GraphQL points left this hour, and Sandbox requests leave 2000 for host calls. It resets at 10:40 UTC (in 25 min).",
      );
      await expect(
        grantForGraphql({
          cache,
          graphql: query,
          operation: "github.pull.get",
        }),
      ).resolves.toMatchObject({ access: "read" });
      vi.setSystemTime(resetAtMs);
      await expect(
        grantForGraphql({ cache, conversationId: "c1", graphql: query }),
      ).resolves.toMatchObject({ access: "read" });
    });
  });
});
