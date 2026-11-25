import type {
  PluginGraphqlField,
  PluginGraphqlOperation,
  PluginGraphqlRequest,
  PluginGraphqlUnreadableReason,
} from "@sentry/junior-plugin-api";
import { describe, expect, it } from "vitest";
import { githubPlugin } from "../src/index";

const GRAPHQL_URL = "https://api.github.com/graphql";
const MUTATIONS_DISABLED = "GraphQL mutations are not enabled";

function operation(
  type: PluginGraphqlOperation["type"],
  rootFields: string[],
  input?: {
    connectionRequests?: number;
    fields?: PluginGraphqlField[];
    name?: string;
  },
): PluginGraphqlOperation {
  return {
    // Core counts 0 for an operation with no connections.
    connectionRequests: input?.connectionRequests ?? 0,
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

async function grantForGraphql(input: {
  graphql?: PluginGraphqlRequest;
  method?: string;
  operation?: string;
  withoutCredential?: true;
}) {
  return await githubPlugin().hooks?.grantForEgress?.({
    db: undefined,
    log: { error() {}, info() {}, warn() {} },
    plugin: { name: "github" },
    request: {
      ...(input.graphql ? { graphql: input.graphql } : undefined),
      method: input.method ?? "POST",
      ...(input.operation ? { operation: input.operation } : undefined),
      url: GRAPHQL_URL,
      ...(input.withoutCredential ? { withoutCredential: true } : undefined),
    },
  });
}

function costedQuery(
  connectionRequests: number | undefined,
  fields: PluginGraphqlField[] = [{ arguments: ["first"], name: "search" }],
): PluginGraphqlRequest {
  const query = operation(
    "query",
    fields.map((field) => field.name),
    { fields },
  );
  if (connectionRequests === undefined) {
    // Core leaves the count unset when a page size is not an integer.
    const { connectionRequests: _uncounted, ...uncounted } = query;
    return single(uncounted);
  }
  return single({ ...query, connectionRequests });
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

  it.each([1, 2049])(
    "allows a Sandbox query with %i connection requests",
    async (connectionRequests) => {
      await expect(
        grantForGraphql({ graphql: costedQuery(connectionRequests) }),
      ).resolves.toMatchObject({ access: "read" });
    },
  );

  it.each([
    [2050, 21],
    [11_011, 110],
  ])(
    "denies a Sandbox query with %i connection requests",
    async (connectionRequests, cost) => {
      await expect(
        grantForGraphql({ graphql: costedQuery(connectionRequests) }),
      ).rejects.toThrow(
        `it can cost about ${cost} points, and the Sandbox limit is 20 points a query`,
      );
    },
  );

  it("does not cap host tool queries or requests with their own credential", async () => {
    const graphql = costedQuery(11_011);
    await expect(
      grantForGraphql({
        graphql,
        operation: "github.pull.get:getsentry/junior",
      }),
    ).resolves.toMatchObject({ access: "read" });
    await expect(
      grantForGraphql({ graphql, withoutCredential: true }),
    ).resolves.toMatchObject({ access: "read" });
  });

  it("allows a rateLimit dry run of an expensive query", async () => {
    await expect(
      grantForGraphql({
        graphql: costedQuery(11_011, [
          { arguments: ["first"], name: "search" },
          {
            arguments: ["dryRun"],
            name: "rateLimit",
            trueArguments: ["dryRun"],
          },
        ]),
      }),
    ).resolves.toMatchObject({ access: "read" });
  });

  it("caps an expensive query whose rateLimit dryRun is not true", async () => {
    await expect(
      grantForGraphql({
        graphql: costedQuery(11_011, [
          { arguments: ["first"], name: "search" },
          { arguments: ["dryRun"], name: "rateLimit" },
        ]),
      }),
    ).rejects.toThrow("GitHub GraphQL query denied");
  });

  it("denies a query whose cost was not counted", async () => {
    await expect(
      grantForGraphql({ graphql: costedQuery(undefined) }),
    ).rejects.toThrow("its cost cannot be predicted");
  });
});
