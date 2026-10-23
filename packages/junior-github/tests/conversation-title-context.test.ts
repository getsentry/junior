import { describe, expect, it, vi } from "vitest";
import { loadGitHubConversationTitleContext } from "../src/conversation-title-context";

const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };

describe("GitHub conversation title context", () => {
  it("reads each distinct issue and pull request link once", async () => {
    const loadObject = vi.fn(async () => ({ title: "Title" }));

    await loadGitHubConversationTitleContext({
      loadObject,
      log,
      text: [
        "Fix this <https://github.com/getsentry/junior/issues/1583>",
        "again https://github.com/getsentry/junior/issues/1583#issuecomment-1",
        "see https://github.com/getsentry/sentry-docs/pull/42/files",
        "and https://github.com/getsentry/junior/blob/main/README.md",
      ].join("\n"),
    });

    expect(loadObject.mock.calls.map(([link]) => link)).toEqual([
      { kind: "issue", name: "junior", number: 1583, owner: "getsentry" },
      {
        kind: "pull_request",
        name: "sentry-docs",
        number: 42,
        owner: "getsentry",
      },
    ]);
  });

  it("describes readable objects and leaves out failed reads", async () => {
    const loadObject = vi.fn(async (link: { number: number }) => {
      if (link.number === 7) throw new Error("Not Found");
      return { title: "  Conversation titles   ignore issue titles " };
    });

    await expect(
      loadGitHubConversationTitleContext({
        loadObject,
        log,
        text: "Fix https://github.com/getsentry/junior/issues/1583 and https://github.com/getsentry/private/issues/7",
      }),
    ).resolves.toEqual([
      "getsentry/junior#1583: Conversation titles ignore issue titles",
    ]);
    expect(loadObject).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(
      "github.conversation_title_context.load_failed",
      expect.objectContaining({ "exception.message": "Not Found" }),
    );
  });
});
