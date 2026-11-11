import { describe, expect, it } from "vitest";
import { githubCodeChangeHooks as hooks } from "../src/code-changes";
import { createGitHubApiTestAdapter } from "./github-api-adapter";

const sha = (digit: string) => digit.repeat(40);

function pull(
  number: number,
  base: string,
  head: string,
  state: "open" | "closed" = "open",
) {
  return {
    number,
    state,
    title: `PR ${number}`,
    body: number === 2 ? null : `Body ${number}`,
    html_url: `https://github.com/getsentry/junior/pull/${number}`,
    additions: number,
    deletions: 0,
    head: { ref: head, sha: sha(String(number)) },
    base: { ref: base, sha: sha(String(number - 1)) },
  };
}

/** Hook input with a queued GitHub egress. The hooks use only egress and signal. */
function context(responses: Array<{ body?: unknown; status?: number }>) {
  const adapter = createGitHubApiTestAdapter(responses);
  const ctx = {
    egress: adapter.egress,
    signal: new AbortController().signal,
  };
  return {
    adapter,
    input: <T extends object>(extra: T) => ({ ...ctx, ...extra }),
  };
}

const paths = (adapter: ReturnType<typeof createGitHubApiTestAdapter>) =>
  adapter
    .requests()
    .map(
      (r) => new URL(r.request.url).pathname + new URL(r.request.url).search,
    );

describe("readStack", () => {
  it("returns the open pull requests in Stacks API order with their commits", async () => {
    const { adapter, input } = context([
      { body: pull(4, "b3", "b4") },
      {
        body: [
          {
            pull_requests: [
              { number: 1 },
              { number: 2 },
              { number: 3 },
              { number: 4 },
            ],
          },
        ],
      },
      // #1 merged, so the Walkthrough skips it.
      { body: pull(1, "main", "b1", "closed") },
      { body: pull(2, "b1", "b2") },
      { body: pull(3, "b2", "b3") },
    ]);
    const stack = await hooks.readStack(
      input({
        repository: "getsentry/junior",
        number: 4,
      }),
    );
    expect(stack?.codeChanges.map((c) => c.number)).toEqual([2, 3, 4]);
    expect(stack?.codeChanges[0]).toEqual({
      number: 2,
      title: "PR 2",
      body: "",
      url: "https://github.com/getsentry/junior/pull/2",
      headSha: sha("2"),
      baseSha: sha("1"),
      additions: 2,
      deletions: 0,
    });
    expect(paths(adapter)[1]).toBe(
      "/repos/getsentry/junior/stacks?pull_request=4",
    );
  });

  it("walks base branches down and up when the repository cannot use stacks", async () => {
    const { adapter, input } = context([
      { body: pull(2, "b1", "b2") },
      { status: 404, body: { message: "Not Found" } },
      { body: [{ number: 1, head: { ref: "b1" }, base: { ref: "main" } }] },
      { body: [] },
      { body: [{ number: 3, head: { ref: "b3" }, base: { ref: "b2" } }] },
      // Two children of b3: the chain forks, so it stops at #3.
      {
        body: [
          { number: 4, head: { ref: "b4" }, base: { ref: "b3" } },
          { number: 5, head: { ref: "b5" }, base: { ref: "b3" } },
        ],
      },
      { body: pull(1, "main", "b1") },
      { body: pull(3, "b2", "b3") },
    ]);
    const stack = await hooks.readStack(
      input({
        repository: "getsentry/junior",
        number: 2,
      }),
    );
    expect(stack?.codeChanges.map((c) => c.number)).toEqual([1, 2, 3]);
    expect(paths(adapter).slice(2, 6)).toEqual([
      "/repos/getsentry/junior/pulls?state=open&per_page=2&head=getsentry%3Ab1",
      "/repos/getsentry/junior/pulls?state=open&per_page=2&head=getsentry%3Amain",
      "/repos/getsentry/junior/pulls?state=open&per_page=2&base=b2",
      "/repos/getsentry/junior/pulls?state=open&per_page=2&base=b3",
    ]);
  });

  it("returns nothing for a missing pull request", async () => {
    const { input } = context([
      { status: 404, body: { message: "Not Found" } },
    ]);
    await expect(
      hooks.readStack(
        input({
          repository: "getsentry/junior",
          number: 9,
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("fails when GitHub rejects a stack read", async () => {
    const { input } = context([
      { body: pull(2, "b1", "b2") },
      { status: 500, body: { message: "Server Error" } },
    ]);
    await expect(
      hooks.readStack(
        input({
          repository: "getsentry/junior",
          number: 2,
        }),
      ),
    ).rejects.toThrow("GitHub stack read failed with HTTP 500");
  });

  it("rejects a repository that is not owner/name", async () => {
    const { input } = context([]);
    await expect(
      hooks.readStack(
        input({
          repository: "getsentry/junior/../x",
          number: 2,
        }),
      ),
    ).rejects.toThrow("Invalid GitHub repository");
  });
});

describe("readDiff", () => {
  it("compares the exact commits and maps file statuses", async () => {
    const { adapter, input } = context([
      {
        body: {
          files: [
            {
              filename: "a.ts",
              status: "modified",
              patch: "@@ -1 +1 @@\n-a\n+b",
            },
            {
              filename: "b.ts",
              previous_filename: "old-b.ts",
              status: "renamed",
            },
            { filename: "c.png", status: "added" },
            { filename: "d.ts", status: "copied", patch: "@@ -0,0 +1 @@\n+d" },
          ],
        },
      },
    ]);
    const diff = await hooks.readDiff(
      input({
        repository: "getsentry/junior",
        baseSha: sha("a"),
        headSha: sha("b"),
      }),
    );
    expect(paths(adapter)).toEqual([
      `/repos/getsentry/junior/compare/${sha("a")}...${sha("b")}`,
    ]);
    expect(diff.files).toEqual([
      { path: "a.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" },
      { path: "b.ts", previousPath: "old-b.ts", status: "renamed" },
      { path: "c.png", status: "added" },
      { path: "d.ts", status: "modified", patch: "@@ -0,0 +1 @@\n+d" },
    ]);
  });
});

describe("readFile", () => {
  it("decodes the file at the commit", async () => {
    const { adapter, input } = context([
      {
        body: {
          type: "file",
          encoding: "base64",
          content: Buffer.from("line 1\nline 2\n").toString("base64"),
        },
      },
    ]);
    await expect(
      hooks.readFile(
        input({
          repository: "getsentry/junior",
          sha: sha("c"),
          path: "src/a b.ts",
        }),
      ),
    ).resolves.toBe("line 1\nline 2\n");
    expect(paths(adapter)).toEqual([
      `/repos/getsentry/junior/contents/src/a%20b.ts?ref=${sha("c")}`,
    ]);
  });

  it("returns nothing for a missing file or one too large to read", async () => {
    const { input } = context([
      { status: 404, body: { message: "Not Found" } },
      { body: { type: "file", encoding: "none", content: "" } },
    ]);
    const args = input({
      repository: "getsentry/junior",
      sha: sha("c"),
      path: "src/a.ts",
    });
    await expect(hooks.readFile(args)).resolves.toBeUndefined();
    await expect(hooks.readFile(args)).resolves.toBeUndefined();
  });
});
