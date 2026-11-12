import { describeEval } from "vitest-evals";
import { toolSearchEvals } from "../../src/tool-search-harness";

// Every case comes from the tool descriptions in this catalog. The word
// match alone ranks these wrong, so the fast model reranks them.
describeEval("Tool Search", toolSearchEvals, (it) => {
  it("when no GitHub tool lists issues, it returns none", async ({ run }) => {
    await run({ query: "list issues", source: "github", expected: null });
  });

  it("when no GitHub tool merges a pull request, it returns none", async ({
    run,
  }) => {
    await run({
      query: "merge a pull request",
      source: "github",
      expected: null,
    });
  });

  it("when the query says open an issue, it picks the create tool", async ({
    run,
  }) => {
    await run({
      query: "open an issue",
      source: "github",
      expected: "github_createIssue",
    });
  });

  it("when no GitHub tool deletes a branch, it returns none", async ({
    run,
  }) => {
    await run({ query: "delete a branch", source: "github", expected: null });
  });

  it("when the agent tool is not in the catalog, it returns none", async ({
    run,
  }) => {
    // spawnAgent is a direct tool, so the catalog does not have it.
    await run({ query: "spawn agent reviewer", source: null, expected: null });
  });

  it("when no tool searches code, it returns none", async ({ run }) => {
    await run({ query: "search code", source: null, expected: null });
  });

  it("when one tool has the action and another the object, it returns none", async ({
    run,
  }) => {
    await run({ query: "create repository", source: "github", expected: null });
  });

  it("when the query names the provider, it picks that provider's tool", async ({
    run,
  }) => {
    await run({
      query:
        "create an issue in the ENG project, our team tracks work in Tracker",
      source: null,
      expected: "tracker_create_issue",
    });
  });

  it("when the query says closing an issue, it picks the update tool", async ({
    run,
  }) => {
    await run({
      query: "closing an issue",
      source: "github",
      expected: "github_updateIssue",
    });
  });

  it("when the query says remember something, it picks the create tool", async ({
    run,
  }) => {
    await run({
      query: "remember something",
      source: "memory",
      expected: "memory_createMemory",
    });
  });
});
