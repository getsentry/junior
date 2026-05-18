import { describe, expect, it } from "vitest";
import {
  getGitHubMentionTargets,
  normalizeGitHubMentionTarget,
} from "@/chat/github/mention";
import { stripLeadingBotMention } from "@/chat/runtime/thread-context";

describe("GitHub mention handling", () => {
  it("normalizes GitHub bot handles into mention targets", () => {
    expect(normalizeGitHubMentionTarget("@junior[bot]")).toBe("junior");
    expect(normalizeGitHubMentionTarget(" junior-bot ")).toBe("junior-bot");
  });

  it("keeps configured and GitHub App bot mention variants", () => {
    expect(getGitHubMentionTargets("junior")).toEqual([
      "junior",
      "junior[bot]",
    ]);
    expect(getGitHubMentionTargets("@junior[bot]")).toEqual([
      "junior[bot]",
      "junior",
    ]);
  });

  it("does not invent a bot suffix target from blank config", () => {
    expect(getGitHubMentionTargets(" ")).toEqual([]);
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

  it("strips GitHub App suffix variants when config stores the normalized name", () => {
    const stripped = getGitHubMentionTargets("junior").reduce(
      (next, botUserName) =>
        stripLeadingBotMention(next, {
          botUserName,
          stripLeadingSlackMentionToken: false,
        }),
      "@junior[bot] inspect this PR",
    );

    expect(stripped).toBe("inspect this PR");
  });

  it("does not strip a longer GitHub handle that only shares a prefix", () => {
    expect(
      stripLeadingBotMention("@junior-bot inspect this PR", {
        botUserName: "junior",
      }),
    ).toBe("@junior-bot inspect this PR");
  });
});
