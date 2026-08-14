import type { ToolRegistrationHookContext } from "@sentry/junior-plugin-api";
import { describe, expect, it, vi } from "vitest";
import { createGitHubCloneRepositoryTool } from "../src/tools/clone-repository.js";

function context(
  run: ReturnType<typeof vi.fn>,
  findByRepository = vi.fn().mockResolvedValue([]),
): ToolRegistrationHookContext {
  return {
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    sandbox: {
      root: "/vercel/sandbox",
      juniorRoot: "/vercel/sandbox/.junior",
      run,
      readFile: vi.fn(),
      writeFile: vi.fn(),
    },
    workspaces: { findByRepository },
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
        directory: "repos/junior",
        repo: "getsentry/junior",
      }),
    ).toBe(
      "Shallow-clone getsentry/junior into the local sandbox at repos/junior for inspection (no GitHub mutation).",
    );
  });

  it("clones into a new sandbox directory", async () => {
    const signal = new AbortController().signal;
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
    const tool = createGitHubCloneRepositoryTool(context(run));

    const result = await tool.execute!(
      { repo: "getsentry/junior", directory: "repos/junior" },
      { signal },
    );

    expect(run).toHaveBeenNthCalledWith(1, {
      cmd: "mkdir",
      args: ["-p", "--", "/vercel/sandbox/repos"],
      cwd: "/vercel/sandbox",
      signal: expect.any(AbortSignal),
    });
    expect(run).toHaveBeenNthCalledWith(3, {
      cmd: "git",
      args: [
        "clone",
        "--quiet",
        "--depth=1",
        "--",
        "https://github.com/getsentry/junior.git",
        "repos/junior",
      ],
      cwd: "/vercel/sandbox",
      signal: expect.any(AbortSignal),
    });
    expect(result).toMatchObject({
      path: "/vercel/sandbox/repos/junior",
      repo: "getsentry/junior",
    });
  });

  it("returns Workspace hints", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
    const findByRepository = vi.fn().mockResolvedValue(["junior", "sentry"]);
    const tool = createGitHubCloneRepositoryTool(
      context(run, findByRepository),
    );

    const result = await tool.execute!(
      { repo: "getsentry/junior" },
      {} as never,
    );

    expect(findByRepository).toHaveBeenCalledWith({
      provider: "github",
      repo: "getsentry/junior",
    });
    expect(result).toMatchObject({
      workspaces: ["junior", "sentry"],
    });
  });

  it("rejects an existing destination", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const tool = createGitHubCloneRepositoryTool(context(run));

    await expect(
      tool.execute!({ repo: "getsentry/junior" }, {} as never),
    ).rejects.toThrow("destination already exists");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("rejects a parent destination", () => {
    const tool = createGitHubCloneRepositoryTool(context(vi.fn()));

    expect(() =>
      tool.prepareArguments!({ repo: "getsentry/junior", directory: ".." }),
    ).toThrow("Directory must be a relative path without . or .. segments");
  });

  it("defaults reserved repo names under repos/", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
    const tool = createGitHubCloneRepositoryTool(context(run));

    const result = await tool.execute!(
      { repo: "getsentry/skills" },
      {} as never,
    );

    expect(run).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        args: expect.arrayContaining(["repos/skills"]),
      }),
    );
    expect(result).toMatchObject({ path: "/vercel/sandbox/repos/skills" });
  });

  it("rejects reserved root destination directories", async () => {
    const tool = createGitHubCloneRepositoryTool(context(vi.fn()));

    await expect(
      tool.execute!(
        { repo: "getsentry/skills", directory: "skills" },
        {} as never,
      ),
    ).rejects.toThrow("Directory conflicts with a reserved sandbox path");
  });

  it("removes a partial clone before retrying authorization", async () => {
    const pause = new Error("authorization paused");
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "" })
      .mockRejectedValueOnce(pause)
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
    const tool = createGitHubCloneRepositoryTool(context(run));

    await expect(
      tool.execute!({ repo: "getsentry/junior" }, {} as never),
    ).rejects.toBe(pause);
    expect(run).toHaveBeenNthCalledWith(4, {
      cmd: "rm",
      args: ["-rf", "--", "/vercel/sandbox/repos/junior"],
      cwd: "/vercel/sandbox",
      signal: expect.any(AbortSignal),
    });
  });

  it("keeps the clone when Workspace lookup fails", async () => {
    const lookup = new Error("workspace lookup failed");
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
    const findByRepository = vi.fn().mockRejectedValue(lookup);
    const ctx = context(run, findByRepository);
    const tool = createGitHubCloneRepositoryTool(ctx);

    const result = await tool.execute!(
      { repo: "getsentry/junior" },
      {} as never,
    );

    expect(result).toMatchObject({
      path: "/vercel/sandbox/repos/junior",
      repo: "getsentry/junior",
      workspaces: [],
    });
    expect(ctx.log.error).toHaveBeenCalledWith(
      "github.clone.workspaces_lookup.failed",
      {
        repo: "getsentry/junior",
        error: "workspace lookup failed",
      },
    );
    expect(run).toHaveBeenCalledTimes(3);
  });
});
