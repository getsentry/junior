import { describe, expect, it } from "vitest";
import { normalizeGitHubMentionTarget } from "@/chat/github/mention";
import { stripLeadingBotMention } from "@/chat/runtime/thread-context";

describe("GitHub mention handling", () => {
  it("normalizes GitHub bot handles into mention targets", () => {
    expect(normalizeGitHubMentionTarget("@junior[bot]")).toBe("junior");
    expect(normalizeGitHubMentionTarget(" junior-bot ")).toBe("junior-bot");
  });

  it("strips the configured GitHub mention target from the current turn text", () => {
    expect(
      stripLeadingBotMention("@junior-bot: inspect this PR", {
        botUserName: "junior-bot",
      }),
    ).toBe("inspect this PR");
    expect(
      stripLeadingBotMention("@junior[bot] inspect this PR", {
        botUserName: "junior[bot]",
      }),
    ).toBe("inspect this PR");
  });

  it("does not strip a longer GitHub handle that only shares a prefix", () => {
    expect(
      stripLeadingBotMention("@junior-bot inspect this PR", {
        botUserName: "junior",
      }),
    ).toBe("@junior-bot inspect this PR");
  });
});
