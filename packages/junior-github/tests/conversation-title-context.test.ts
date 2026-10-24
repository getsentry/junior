import { describe, expect, it, vi } from "vitest";
import {
  type GitHubReference,
  loadGitHubConversationTitleContext,
} from "../src/conversation-title-context";

const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };

/** Return the references that title context reads for one message. */
async function readReferences(
  text: string,
  config: Record<string, string> = {},
): Promise<GitHubReference[]> {
  const loadObject = vi.fn(async () => ({ title: "Title" }));
  await loadGitHubConversationTitleContext({ config, loadObject, log, text });
  return loadObject.mock.calls.map(([reference]) => reference);
}

describe("GitHub conversation title context", () => {
  it.each([
    [
      "Fix this <https://github.com/getsentry/junior/issues/1583>",
      { kind: "issue", id: "1583" },
    ],
    [
      "see https://github.com/getsentry/junior/pull/42/files",
      { kind: "pull_request", id: "42" },
    ],
    [
      "why did https://github.com/getsentry/junior/commit/a5c3785ed8d6a35868bc169f07e40e889087fd2e break",
      { kind: "commit", id: "a5c3785ed8d6a35868bc169f07e40e889087fd2e" },
    ],
    ["Fix getsentry/junior#1583", { kind: "issue", id: "1583" }],
    ["Revert getsentry/junior@a5c3785", { kind: "commit", id: "a5c3785" }],
    ["Let's fix issue 1583 on getsentry/junior", { kind: "issue", id: "1583" }],
    [
      "Can you review pull request #42 in getsentry/junior?",
      { kind: "pull_request", id: "42" },
    ],
  ])("reads the reference in %j", async (text, reference) => {
    await expect(readReferences(text)).resolves.toEqual([
      { owner: "getsentry", name: "junior", ...reference },
    ]);
  });

  it("gives bare references the named or configured repository", async () => {
    // One repository named in the message wins over the config.
    await expect(
      readReferences("Fix #12 and GH-13 from getsentry/sentry", {
        repo: "getsentry/junior",
      }),
    ).resolves.toEqual([
      { owner: "getsentry", name: "sentry", kind: "issue", id: "12" },
      { owner: "getsentry", name: "sentry", kind: "issue", id: "13" },
    ]);
    await expect(
      readReferences("Let's get PR 1234 fixed up", {
        org: "getsentry",
        repo: "junior",
      }),
    ).resolves.toEqual([
      { owner: "getsentry", name: "junior", kind: "pull_request", id: "1234" },
    ]);
    // Without a repository, a bare number is not a reference.
    await expect(readReferences("Fix #12 and PR 13")).resolves.toEqual([]);
  });

  it("reads each distinct reference once, up to three", async () => {
    await expect(
      readReferences(
        [
          "Fix https://github.com/getsentry/junior/issues/1",
          "again getsentry/junior#1 and #2, issue 3, PR 4",
          "and https://github.com/getsentry/junior/blob/main/README.md",
          "with &#5; and https://example.com/a#6",
        ].join("\n"),
        { repo: "getsentry/junior" },
      ),
    ).resolves.toEqual([
      { owner: "getsentry", name: "junior", kind: "issue", id: "1" },
      { owner: "getsentry", name: "junior", kind: "issue", id: "2" },
      { owner: "getsentry", name: "junior", kind: "issue", id: "3" },
    ]);
  });

  it("describes readable objects and leaves out failed reads", async () => {
    const loadObject = vi.fn(async (reference: GitHubReference) => {
      if (reference.id === "7") throw new Error("Not Found");
      return reference.kind === "commit"
        ? { commit: { message: "Fix title model\n\nLonger body." } }
        : { title: "  Conversation titles   ignore issue titles " };
    });

    await expect(
      loadGitHubConversationTitleContext({
        config: {},
        loadObject,
        log,
        text: "Fix getsentry/junior#1583, getsentry/private#7, and getsentry/junior@a5c3785ed8d6",
      }),
    ).resolves.toEqual([
      "getsentry/junior#1583: Conversation titles ignore issue titles",
      "getsentry/junior@a5c3785: Fix title model",
    ]);
    expect(log.warn).toHaveBeenCalledWith(
      "github.conversation_title_context.load_failed",
      expect.objectContaining({ "exception.message": "Not Found" }),
    );
  });
});
