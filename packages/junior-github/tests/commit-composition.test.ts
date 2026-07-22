import { describe, expect, it, vi } from "vitest";
import { classifyGitHubPullRequestCommitComposition } from "../src/pull-request-outcomes/commit-composition";

const BOT_EMAIL = "264270552+sentry-junior[bot]@users.noreply.github.com";

function commit(input: { email: string; login: string | null }) {
  return {
    author: input.login ? { login: input.login } : null,
    commit: { author: { email: input.email } },
  };
}

describe("GitHub pull request commit composition", () => {
  it("classifies bot-login and bot-email commits as Junior-only", async () => {
    const composition = await classifyGitHubPullRequestCommitComposition({
      botEmail: BOT_EMAIL,
      async loadPage() {
        return [
          commit({
            email: "unrelated@example.com",
            login: "sentry-junior[bot]",
          }),
          commit({ email: BOT_EMAIL, login: null }),
        ];
      },
    });

    expect(composition).toBe("junior_only");
  });

  it("checks subsequent pages and classifies any human-authored commit as mixed", async () => {
    const juniorCommit = commit({ email: BOT_EMAIL, login: null });
    const loadPage = vi
      .fn()
      .mockResolvedValueOnce(Array.from({ length: 100 }, () => juniorCommit))
      .mockResolvedValueOnce([
        commit({ email: "human@example.com", login: "human" }),
      ]);

    await expect(
      classifyGitHubPullRequestCommitComposition({
        botEmail: BOT_EMAIL,
        loadPage,
      }),
    ).resolves.toBe("mixed");
    expect(loadPage).toHaveBeenNthCalledWith(1, 1, 100);
    expect(loadPage).toHaveBeenNthCalledWith(2, 2, 100);
  });

  it("leaves composition unknown at GitHub's 250-commit listing cap", async () => {
    const juniorCommit = commit({ email: BOT_EMAIL, login: null });
    const loadPage = vi
      .fn()
      .mockResolvedValueOnce(Array.from({ length: 100 }, () => juniorCommit))
      .mockResolvedValueOnce(Array.from({ length: 100 }, () => juniorCommit))
      .mockResolvedValueOnce(Array.from({ length: 50 }, () => juniorCommit));

    await expect(
      classifyGitHubPullRequestCommitComposition({
        botEmail: BOT_EMAIL,
        loadPage,
      }),
    ).resolves.toBeUndefined();
    expect(loadPage).toHaveBeenCalledTimes(3);
  });
});
