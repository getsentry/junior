import { describe, expect, it } from "vitest";
import { isGraphqlPost, readGraphqlRequest } from "@/chat/egress/graphql";

function body(value: unknown): ArrayBuffer {
  const bytes = new TextEncoder().encode(
    typeof value === "string" ? value : JSON.stringify(value),
  );
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
}

function read(value: unknown) {
  return readGraphqlRequest(body(value));
}

describe("isGraphqlPost", () => {
  it("matches POSTs to a /graphql path", () => {
    expect(
      isGraphqlPost("post", new URL("https://api.github.com/graphql")),
    ).toBe(true);
    expect(
      isGraphqlPost("POST", new URL("https://example.test/api/GraphQL")),
    ).toBe(true);
    expect(
      isGraphqlPost("GET", new URL("https://api.github.com/graphql")),
    ).toBe(false);
    expect(
      isGraphqlPost("POST", new URL("https://api.github.com/graphql/x")),
    ).toBe(false);
  });
});

describe("readGraphqlRequest", () => {
  it("reads a named query with its fields at every depth", async () => {
    expect(
      await read({
        query:
          'query IssueList { repository(owner: "getsentry", name: "junior") { issues(first: 1) { nodes { number } } } }',
      }),
    ).toEqual({
      kind: "operation",
      operation: {
        connectionRequests: 1,
        fields: [
          { arguments: ["owner", "name"], name: "repository" },
          { arguments: ["first"], name: "issues" },
          { arguments: [], name: "nodes" },
          { arguments: [], name: "number" },
        ],
        name: "IssueList",
        rootFields: ["repository"],
        type: "query",
      },
    });
  });

  it("reads a shorthand query", async () => {
    expect(await read({ query: "{ viewer { login } }" })).toMatchObject({
      kind: "operation",
      operation: { rootFields: ["viewer"], type: "query" },
    });
  });

  it("ignores operation keywords in strings and comments", async () => {
    expect(
      await read({
        query:
          '# mutation Hidden { createIssue }\nquery Search { search(query: "mutation subscription", type: ISSUE, first: 1) { issueCount } }',
      }),
    ).toMatchObject({
      kind: "operation",
      operation: { name: "Search", rootFields: ["search"], type: "query" },
    });
  });

  it("names the schema field, not its alias", async () => {
    expect(
      await read({
        query:
          "mutation ResolveReviewThread { resolveReviewThread: addComment(input: {}) { clientMutationId } again: addComment(input: {}) { clientMutationId } }",
      }),
    ).toMatchObject({
      kind: "operation",
      operation: {
        name: "ResolveReviewThread",
        rootFields: ["addComment", "addComment"],
        type: "mutation",
      },
    });
  });

  it("reads root fields through fragment spreads and inline fragments", async () => {
    expect(
      await read({
        operationName: "CreateIssue",
        query:
          'fragment create on Mutation { createIssue(input: {title: "x"}) { issue { ...number } } } fragment number on Issue { number } mutation CreateIssue { ...create ... on Mutation { updateIssue(input: {}) { clientMutationId } } }',
      }),
    ).toMatchObject({
      kind: "operation",
      operation: {
        fields: expect.arrayContaining([
          { arguments: ["input"], name: "createIssue" },
          { arguments: [], name: "number" },
          { arguments: ["input"], name: "updateIssue" },
        ]),
        rootFields: ["createIssue", "updateIssue"],
        type: "mutation",
      },
    });
  });

  it("selects the operation that operationName names", async () => {
    const query =
      "query ReadIssues { viewer { login } } mutation CreateIssue { createIssue(input: {}) { clientMutationId } }";
    expect(await read({ operationName: "ReadIssues", query })).toMatchObject({
      operation: { name: "ReadIssues", type: "query" },
    });
    expect(await read({ operationName: "CreateIssue", query })).toMatchObject({
      operation: { name: "CreateIssue", type: "mutation" },
    });
  });

  it("does not guess an operation from a multi-operation document", async () => {
    const query =
      "query ReadIssues { viewer { login } } mutation CreateIssue { createIssue(input: {}) { clientMutationId } }";
    expect(await read({ query })).toEqual({
      kind: "unreadable",
      reason: "operation",
    });
    expect(await read({ operationName: null, query })).toEqual({
      kind: "unreadable",
      reason: "operation",
    });
    expect(await read({ operationName: "Missing", query })).toEqual({
      kind: "unreadable",
      reason: "operation",
    });
    expect(
      await read({ operationName: 1, query: "{ viewer { login } }" }),
    ).toEqual({
      kind: "unreadable",
      reason: "operation",
    });
  });

  it("reads each entry of a batch", async () => {
    expect(
      await read([
        { query: "{ viewer { login } }" },
        { query: "mutation { addComment(input: {}) { clientMutationId } }" },
      ]),
    ).toMatchObject({
      kind: "batch",
      operations: [
        { rootFields: ["viewer"], type: "query" },
        { rootFields: ["addComment"], type: "mutation" },
      ],
    });
    expect(
      await read([{ query: "{ viewer { login } }" }, { query: "{" }]),
    ).toEqual({
      kind: "unreadable",
      reason: "document",
    });
  });

  it("stops at fragment cycles", async () => {
    expect(
      await read({
        query:
          "fragment a on Query { viewer { login } ...b } fragment b on Query { ...a } query { ...a }",
      }),
    ).toMatchObject({
      kind: "operation",
      operation: { rootFields: ["viewer"], type: "query" },
    });
  });

  it("counts connection requests the way GitHub predicts query cost", async () => {
    // The example in GitHub's GraphQL rate limit docs needs 5,101 requests.
    expect(
      await read({
        query:
          "{ viewer { login repositories(first: 100) { edges { node { id issues(first: 50) { edges { node { id labels(first: 60) { edges { node { name } } } } } } } } } } }",
      }),
    ).toMatchObject({ operation: { connectionRequests: 5101 } });
  });

  it("counts page sizes from variables, defaults, and fragments", async () => {
    expect(
      await read({
        query:
          "fragment issues on Repository { issues(first: $issues) { nodes { labels(last: 10) { nodes { name } } } } } query($repos: Int!, $issues: Int = 5) { viewer { repositories(first: $repos) { nodes { ...issues } } } }",
        variables: { repos: 20 },
      }),
    ).toMatchObject({ operation: { connectionRequests: 1 + 20 * (1 + 5) } });
  });

  it("counts each fragment once however often it is spread", async () => {
    const levels = Array.from(
      { length: 30 },
      (_, index) =>
        `fragment f${index} on Query { ...f${index + 1} ...f${index + 1} }`,
    ).join(" ");
    expect(
      await read({
        query: `${levels} fragment f30 on Query { viewer { repositories(first: 1) { nodes { name } } } } query { ...f0 }`,
      }),
    ).toMatchObject({ operation: { connectionRequests: 2 ** 30 } });
  });

  it("leaves the count unset for a page size it cannot resolve", async () => {
    const result = await read({
      query:
        "query($n: Int) { viewer { repositories(first: $n) { nodes { name } } } }",
    });
    expect(result).toMatchObject({ kind: "operation" });
    expect(result).not.toHaveProperty("operation.connectionRequests");
  });

  it.each([
    [
      "a literal",
      "query { rateLimit(dryRun: true) { cost } }",
      undefined,
      true,
    ],
    [
      "a variable",
      "query($dry: Boolean!) { rateLimit(dryRun: $dry) { cost } }",
      { dry: true },
      true,
    ],
    [
      "a variable default",
      "query($dry: Boolean = true) { rateLimit(dryRun: $dry) { cost } }",
      undefined,
      true,
    ],
    [
      "a false literal",
      "query { rateLimit(dryRun: false) { cost } }",
      undefined,
      false,
    ],
    [
      "a variable set to false over a true default",
      "query($dry: Boolean = true) { rateLimit(dryRun: $dry) { cost } }",
      { dry: false },
      false,
    ],
    [
      "a field that @include can drop",
      "query { rateLimit(dryRun: true) @include(if: false) { cost } }",
      undefined,
      false,
    ],
    [
      "a field that @skip can drop through a variable",
      "query($s: Boolean!) { rateLimit(dryRun: true) @skip(if: $s) { cost } }",
      { s: true },
      false,
    ],
    [
      "a fragment that @skip can drop",
      "query { ... @skip(if: true) { rateLimit(dryRun: true) { cost } } }",
      undefined,
      false,
    ],
    [
      "a field that @skip keeps",
      "query { rateLimit(dryRun: true) @skip(if: false) { cost } }",
      undefined,
      true,
    ],
  ])(
    "reads a true argument from %s",
    async (_name, query, variables, isTrue) => {
      const result = await read({
        query,
        ...(variables ? { variables } : undefined),
      });
      if (result.kind !== "operation") throw new Error(result.kind);
      expect(result.operation.fields[0]).toEqual({
        arguments: ["dryRun"],
        name: "rateLimit",
        ...(isTrue ? { trueArguments: ["dryRun"] } : undefined),
      });
    },
  );

  it("reads subscriptions", async () => {
    expect(
      await read({ query: "subscription { events { id } }" }),
    ).toMatchObject({
      operation: { rootFields: ["events"], type: "subscription" },
    });
  });

  it.each([
    ["an empty body", "", "json"],
    ["malformed JSON", "{", "json"],
    ["a JSON string", '"query"', "json"],
    ["a JSON null", "null", "json"],
    ["a batch of non-objects", "[1]", "json"],
    ["no query", { variables: {} }, "query"],
    [
      "a persisted query hash",
      { extensions: { persistedQuery: { sha256Hash: "abc", version: 1 } } },
      "query",
    ],
    ["a query that does not parse", { query: "mutation {" }, "document"],
    [
      "a spread of an undefined fragment",
      { query: "mutation { ...hidden }" },
      "document",
    ],
    [
      "two fragments with one name",
      {
        query:
          "fragment f on Query { viewer { login } } fragment f on Mutation { addComment(input: {}) { clientMutationId } } query { ...f }",
      },
      "document",
    ],
    [
      "fragments without an operation",
      { query: "fragment f on Query { a }" },
      "operation",
    ],
  ])("reports %s as unreadable", async (_name, value, reason) => {
    expect(await read(value)).toEqual({ kind: "unreadable", reason });
  });

  it("reports a missing body as unreadable", async () => {
    expect(await readGraphqlRequest(undefined)).toEqual({
      kind: "unreadable",
      reason: "json",
    });
  });

  it("reports gzip and oversized bodies as unreadable", async () => {
    expect(
      await readGraphqlRequest(new Uint8Array([0x1f, 0x8b, 0x08, 0x00]).buffer),
    ).toEqual({ kind: "unreadable", reason: "gzip" });
    expect(
      await read({
        query: "{ viewer { login } }",
        filler: "x".repeat(64 * 1024),
      }),
    ).toEqual({ kind: "unreadable", reason: "too-large" });
  });
});
