import { bindPluginTool } from "@sentry/junior-testing/plugin-tool";
import { PluginToolInputError } from "@sentry/junior-plugin-api";
import { describe, expect, it, vi } from "vitest";
import { gitHubCloneRepositoryTool } from "../src/tools/clone-repository.js";

function context(
  run: ReturnType<typeof vi.fn>,
  findByRepository = vi.fn().mockResolvedValue([]),
  active = vi.fn().mockResolvedValue(undefined),
) {
  return {
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    sandbox: {
      root: "/vercel/sandbox",
      juniorRoot: "/vercel/sandbox/.junior",
      run,
      readFile: vi.fn(),
      writeFile: vi.fn(),
    },
    workspaces: { active, findByRepository },
  };
}

describe("cloneRepository", () => {
  it("declares clone as a non-destructive open-world read", () => {
    const tool = bindPluginTool(gitHubCloneRepositoryTool, context(vi.fn()));

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
    expect(
      tool.describeProposal?.({
        allow_ad_hoc: true,
        repo: "getsentry/junior",
      }),
    ).toBe(
      "Shallow-clone getsentry/junior into the local sandbox as an intentional ad-hoc checkout for inspection (no GitHub mutation).",
    );
  });

  it("clones into a new sandbox directory", async () => {
    const signal = new AbortController().signal;
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
    const findByRepository = vi.fn().mockResolvedValue([]);
    const tool = bindPluginTool(
      gitHubCloneRepositoryTool,
      context(run, findByRepository),
    );

    const result = await tool.execute(
      { repo: "getsentry/junior", directory: "repos/junior" },
      { signal },
    );

    expect(findByRepository).toHaveBeenCalledWith({
      provider: "github",
      repo: "getsentry/junior",
    });
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

  it("rejects matching Workspaces as a tool input error before cloning", async () => {
    const run = vi.fn();
    const findByRepository = vi.fn().mockResolvedValue(["junior", "sentry"]);
    const tool = bindPluginTool(
      gitHubCloneRepositoryTool,
      context(run, findByRepository),
    );

    const error = await tool
      .execute({ repo: "getsentry/junior" }, {})
      .catch((value) => value);
    expect(error).toBeInstanceOf(PluginToolInputError);
    expect(error).toMatchObject({
      name: "PluginToolInputError",
      message:
        'Repository getsentry/junior is part of Workspaces "junior", "sentry". Call switchWorkspace with one of those names; the checkout is already present after the switch. Pass allow_ad_hoc=true only for an intentional ad-hoc checkout.',
    });
    expect(findByRepository).toHaveBeenCalledWith({
      provider: "github",
      repo: "getsentry/junior",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects a single matching Workspace as a tool input error", async () => {
    const run = vi.fn();
    const findByRepository = vi.fn().mockResolvedValue(["junior"]);
    const tool = bindPluginTool(
      gitHubCloneRepositoryTool,
      context(run, findByRepository),
    );

    await expect(
      tool.execute({ repo: "getsentry/junior" }, {}),
    ).rejects.toMatchObject({
      name: "PluginToolInputError",
      message:
        'Repository getsentry/junior is part of Workspace "junior". Call switchWorkspace with that name; the checkout is already present after the switch. Pass allow_ad_hoc=true only for an intentional ad-hoc checkout.',
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("clones when allow_ad_hoc overrides matching Workspaces", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
    const findByRepository = vi.fn().mockResolvedValue(["junior", "sentry"]);
    const tool = bindPluginTool(
      gitHubCloneRepositoryTool,
      context(run, findByRepository),
    );

    const result = await tool.execute(
      { allow_ad_hoc: true, repo: "getsentry/junior" },
      {},
    );

    expect(findByRepository).toHaveBeenCalledWith({
      provider: "github",
      repo: "getsentry/junior",
    });
    expect(run).toHaveBeenCalled();
    expect(result).toMatchObject({
      path: "/vercel/sandbox/repos/junior",
      repo: "getsentry/junior",
    });
  });

  it("clones inside another Workspace and notes the matching Workspaces", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
    const findByRepository = vi.fn().mockResolvedValue(["sentry", "monorepo"]);
    const active = vi.fn().mockResolvedValue({ name: "monorepo" });
    const tool = bindPluginTool(
      gitHubCloneRepositoryTool,
      context(run, findByRepository, active),
    );

    const result = await tool.execute({ repo: "getsentry/sentry" }, {});

    expect(run).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      target: "cloneRepository",
      path: "/vercel/sandbox/repos/sentry",
      repo: "getsentry/sentry",
      note: 'Cloned getsentry/sentry ad hoc to keep the current Workspace "monorepo". Workspace "sentry" also includes getsentry/sentry. switchWorkspace replaces this Sandbox and drops its files.',
    });
  });

  it("treats a Workspace Sandbox without a recipe as a Workspace", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
    const tool = bindPluginTool(
      gitHubCloneRepositoryTool,
      context(
        run,
        vi.fn().mockResolvedValue(["sentry"]),
        vi.fn().mockResolvedValue({}),
      ),
    );

    const result = await tool.execute({ repo: "getsentry/sentry" }, {});

    expect(result).toMatchObject({
      note: 'Cloned getsentry/sentry ad hoc to keep the current Workspace. Workspace "sentry" also includes getsentry/sentry. switchWorkspace replaces this Sandbox and drops its files.',
    });
  });

  it("rejects an existing destination", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const tool = bindPluginTool(gitHubCloneRepositoryTool, context(run));

    await expect(
      tool.execute({ repo: "getsentry/junior" }, {}),
    ).rejects.toThrow("destination already exists");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("rejects a parent destination", () => {
    const tool = bindPluginTool(gitHubCloneRepositoryTool, context(vi.fn()));

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
    const tool = bindPluginTool(gitHubCloneRepositoryTool, context(run));

    const result = await tool.execute({ repo: "getsentry/skills" }, {});

    expect(run).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        args: expect.arrayContaining(["repos/skills"]),
      }),
    );
    expect(result).toMatchObject({ path: "/vercel/sandbox/repos/skills" });
  });

  it("rejects reserved root destination directories", async () => {
    const tool = bindPluginTool(gitHubCloneRepositoryTool, context(vi.fn()));

    await expect(
      tool.execute({ repo: "getsentry/skills", directory: "skills" }, {}),
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
    const tool = bindPluginTool(gitHubCloneRepositoryTool, context(run));

    await expect(tool.execute({ repo: "getsentry/junior" }, {})).rejects.toBe(
      pause,
    );
    expect(run).toHaveBeenNthCalledWith(4, {
      cmd: "rm",
      args: ["-rf", "--", "/vercel/sandbox/repos/junior"],
      cwd: "/vercel/sandbox",
      signal: expect.any(AbortSignal),
    });
  });

  it("keeps cloning when Workspace lookup fails", async () => {
    const lookup = new Error("workspace lookup failed");
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
    const findByRepository = vi.fn().mockRejectedValue(lookup);
    const ctx = context(run, findByRepository);
    const tool = bindPluginTool(gitHubCloneRepositoryTool, ctx);

    const result = await tool.execute({ repo: "getsentry/junior" }, {});

    expect(result).toMatchObject({
      path: "/vercel/sandbox/repos/junior",
      repo: "getsentry/junior",
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
