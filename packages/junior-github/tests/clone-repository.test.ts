import type { ToolRegistrationHookContext } from "@sentry/junior-plugin-api";
import { describe, expect, it, vi } from "vitest";
import { createGitHubCloneRepositoryTool } from "../src/tools/clone-repository.js";

function context(run: ReturnType<typeof vi.fn>): ToolRegistrationHookContext {
  return {
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    sandbox: {
      root: "/vercel/sandbox",
      juniorRoot: "/vercel/sandbox/.junior",
      run,
      readFile: vi.fn(),
      writeFile: vi.fn(),
    },
  } as unknown as ToolRegistrationHookContext;
}

describe("cloneRepository", () => {
  it("declares clone as a non-destructive open-world read", () => {
    const tool = createGitHubCloneRepositoryTool(context(vi.fn()));

    expect(tool.annotations).toEqual({
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: true,
    });
    expect(
      tool.describeProposal?.({
        directory: "junior",
        repo: "getsentry/junior",
      }),
    ).toBe(
      "Shallow-clone getsentry/junior into the local sandbox at junior for inspection (no GitHub mutation).",
    );
  });

  it("clones into a new sandbox directory", async () => {
    const signal = new AbortController().signal;
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
    const tool = createGitHubCloneRepositoryTool(context(run));

    const result = await tool.execute!(
      { repo: "getsentry/junior", directory: "junior" },
      { signal },
    );

    expect(run).toHaveBeenNthCalledWith(2, {
      cmd: "git",
      args: [
        "clone",
        "--quiet",
        "--depth=1",
        "--",
        "https://github.com/getsentry/junior.git",
        "junior",
      ],
      cwd: "/vercel/sandbox",
      signal: expect.any(AbortSignal),
    });
    expect(result).toMatchObject({
      path: "/vercel/sandbox/junior",
      repo: "getsentry/junior",
    });
  });

  it("rejects an existing destination", async () => {
    const run = vi
      .fn()
      .mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const tool = createGitHubCloneRepositoryTool(context(run));

    await expect(
      tool.execute!({ repo: "getsentry/junior" }, {} as never),
    ).rejects.toThrow("destination already exists");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rejects a parent destination", () => {
    const tool = createGitHubCloneRepositoryTool(context(vi.fn()));

    expect(() =>
      tool.prepareArguments!({ repo: "getsentry/junior", directory: ".." }),
    ).toThrow("Directory must be a single directory name");
  });

  it("avoids reserved sandbox directories by default", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
    const tool = createGitHubCloneRepositoryTool(context(run));

    const result = await tool.execute!(
      { repo: "getsentry/skills" },
      {} as never,
    );

    expect(run).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        args: expect.arrayContaining(["skills-repo"]),
      }),
    );
    expect(result).toMatchObject({ path: "/vercel/sandbox/skills-repo" });
  });

  it("removes a partial clone before retrying authorization", async () => {
    const pause = new Error("authorization paused");
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "" })
      .mockRejectedValueOnce(pause)
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
    const tool = createGitHubCloneRepositoryTool(context(run));

    await expect(
      tool.execute!({ repo: "getsentry/junior" }, {} as never),
    ).rejects.toBe(pause);
    expect(run).toHaveBeenNthCalledWith(3, {
      cmd: "rm",
      args: ["-rf", "--", "/vercel/sandbox/junior"],
      cwd: "/vercel/sandbox",
      signal: expect.any(AbortSignal),
    });
  });
});
