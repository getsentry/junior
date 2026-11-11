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
  it("reads a named query with its fields at every depth", () => {
    expect(
      read({
        query:
          'query IssueList { repository(owner: "getsentry", name: "junior") { issues(first: 1) { nodes { number } } } }',
      }),
    ).toEqual({
      kind: "operation",
      operation: {
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

  it("reads a shorthand query", () => {
    expect(read({ query: "{ viewer { login } }" })).toMatchObject({
      kind: "operation",
      operation: { rootFields: ["viewer"], type: "query" },
    });
  });

  it("ignores operation keywords in strings and comments", () => {
    expect(
      read({
        query:
          '# mutation Hidden { createIssue }\nquery Search { search(query: "mutation subscription", type: ISSUE, first: 1) { issueCount } }',
      }),
    ).toMatchObject({
      kind: "operation",
      operation: { name: "Search", rootFields: ["search"], type: "query" },
    });
  });

  it("names the schema field, not its alias", () => {
    expect(
      read({
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

  it("reads root fields through fragment spreads and inline fragments", () => {
    expect(
      read({
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

  it("selects the operation that operationName names", () => {
    const query =
      "query ReadIssues { viewer { login } } mutation CreateIssue { createIssue(input: {}) { clientMutationId } }";
    expect(read({ operationName: "ReadIssues", query })).toMatchObject({
      operation: { name: "ReadIssues", type: "query" },
    });
    expect(read({ operationName: "CreateIssue", query })).toMatchObject({
      operation: { name: "CreateIssue", type: "mutation" },
    });
  });

  it("does not guess an operation from a multi-operation document", () => {
    const query =
      "query ReadIssues { viewer { login } } mutation CreateIssue { createIssue(input: {}) { clientMutationId } }";
    expect(read({ query })).toEqual({
      kind: "unreadable",
      reason: "operation",
    });
    expect(read({ operationName: null, query })).toEqual({
      kind: "unreadable",
      reason: "operation",
    });
    expect(read({ operationName: "Missing", query })).toEqual({
      kind: "unreadable",
      reason: "operation",
    });
    expect(read({ operationName: 1, query: "{ viewer { login } }" })).toEqual({
      kind: "unreadable",
      reason: "operation",
    });
  });

  it("reads each entry of a batch", () => {
    expect(
      read([
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
    expect(read([{ query: "{ viewer { login } }" }, { query: "{" }])).toEqual({
      kind: "unreadable",
      reason: "document",
    });
  });

  it("stops at fragment cycles", () => {
    expect(
      read({
        query:
          "fragment a on Query { viewer { login } ...b } fragment b on Query { ...a } query { ...a }",
      }),
    ).toMatchObject({
      kind: "operation",
      operation: { rootFields: ["viewer"], type: "query" },
    });
  });

  it("reads subscriptions", () => {
    expect(read({ query: "subscription { events { id } }" })).toMatchObject({
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
  ])("reports %s as unreadable", (_name, value, reason) => {
    expect(read(value)).toEqual({ kind: "unreadable", reason });
  });

  it("reports a missing body as unreadable", () => {
    expect(readGraphqlRequest(undefined)).toEqual({
      kind: "unreadable",
      reason: "json",
    });
  });

  it("reports gzip and oversized bodies as unreadable", () => {
    expect(
      readGraphqlRequest(new Uint8Array([0x1f, 0x8b, 0x08, 0x00]).buffer),
    ).toEqual({ kind: "unreadable", reason: "gzip" });
    expect(
      read({ query: "{ viewer { login } }", filler: "x".repeat(64 * 1024) }),
    ).toEqual({ kind: "unreadable", reason: "too-large" });
  });
});
