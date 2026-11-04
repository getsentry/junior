import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { describe, expect, it, vi } from "vitest";
import { getDb } from "@/chat/db";
import { createApp, defineJuniorPlugins } from "@/app";
import { createPluginHookRunner } from "@/chat/plugins/agent-hooks";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import { SkillSandbox } from "@/chat/sandbox/skill-sandbox";
import { createPiAgentTools } from "@/chat/tool-support/pi-tool-adapter";
import { juniorWorkspaceRepos, juniorWorkspaces } from "@/db/schema";

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

async function insertWorkspace() {
  const now = new Date("2026-11-04T00:00:00.000Z");
  const db = getDb();
  await db.insert(juniorWorkspaces).values({
    id: WORKSPACE_ID,
    name: "junior",
    setupScript: "",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(juniorWorkspaceRepos).values({
    workspaceId: WORKSPACE_ID,
    provider: "github",
    repo: "getsentry/junior",
  });
}

function fakeSandbox(diff: string): SandboxWorkspace {
  return {
    async readFileToBuffer() {
      return null;
    },
    async runCommand() {
      return { exitCode: 0, stdout: diff, stderr: "" };
    },
    async writeFiles() {},
  };
}

function editTool(sandboxWorkspace: SandboxWorkspace, workspaceId?: string) {
  const execute = vi.fn(async () => ({ ok: true }));
  const [tool] = createPiAgentTools(
    {
      editFile: {
        description: "Edit a file.",
        inputSchema: {} as any,
        execute,
      },
    },
    new SkillSandbox([], []),
    {},
    undefined,
    undefined,
    undefined,
    undefined,
    createPluginHookRunner({
      sandbox: () => ({
        workspace: sandboxWorkspace,
        workspaceId: () => workspaceId,
      }),
    }),
  );
  return { execute, tool: tool! };
}

describe("afterToolExecute plugin hooks", () => {
  it("checks the finished call against the active Workspace and nudges the agent", async () => {
    await insertWorkspace();
    const seen: unknown[] = [];
    await createApp({
      plugins: defineJuniorPlugins([
        defineJuniorPlugin({
          manifest: {
            name: "eval-guard",
            displayName: "Eval guard",
            description: "Checks eval edits.",
          },
          hooks: {
            async afterToolExecute(ctx) {
              seen.push({ tool: ctx.tool, workspace: ctx.workspace });
              const repo = ctx.workspace?.repos[0];
              if (!repo) return;
              const diff = await ctx.sandbox.run({
                cmd: "git",
                args: ["diff", "--", "evals/"],
                cwd: `${ctx.sandbox.root}/${repo.path}`,
              });
              if (diff.stdout.includes("toContain")) {
                ctx.decision.nudge("The eval asserts <exact> wording.");
              }
            },
          },
        }),
      ]),
    });
    const { execute, tool } = editTool(
      fakeSandbox('+ expect(reply).toContain("done")'),
      WORKSPACE_ID,
    );

    const result = await tool.execute("call-1", { path: "evals/a.eval.ts" });

    expect(execute).toHaveBeenCalledOnce();
    expect(seen).toEqual([
      {
        tool: { input: { path: "evals/a.eval.ts" }, name: "editFile" },
        workspace: {
          name: "junior",
          repos: [
            {
              path: "repos/junior",
              provider: "github",
              repo: "getsentry/junior",
            },
          ],
        },
      },
    ]);
    expect(result.content.at(-1)).toEqual({
      type: "text",
      text: '<plugin-note plugin="eval-guard">The eval asserts &lt;exact&gt; wording.</plugin-note>',
    });
  });

  it("rejects the result on denial and ignores a check that fails", async () => {
    await createApp({
      plugins: defineJuniorPlugins([
        defineJuniorPlugin({
          manifest: {
            name: "broken-check",
            displayName: "Broken check",
            description: "Throws.",
          },
          hooks: {
            afterToolExecute() {
              throw new Error("judge unavailable");
            },
          },
        }),
        defineJuniorPlugin({
          manifest: {
            name: "strict-check",
            displayName: "Strict check",
            description: "Denies.",
          },
          hooks: {
            afterToolExecute(ctx) {
              expect(ctx.workspace).toBeUndefined();
              if (ctx.tool.input.path === "evals/a.eval.ts") {
                ctx.decision.deny("Eval edits need a person.");
              }
            },
          },
        }),
      ]),
    });
    const { tool } = editTool(fakeSandbox(""));

    await expect(tool.execute("call-2", { path: "src/a.ts" })).resolves.toEqual(
      {
        content: [{ type: "text", text: '{"ok":true}' }],
        details: { ok: true },
      },
    );
    await expect(
      tool.execute("call-3", { path: "evals/a.eval.ts" }),
    ).rejects.toThrow(
      /This action ran, but policy rejected its result\.[\s\S]*Reason: Eval edits need a person\./,
    );
  });

  it("keeps the finished result when the run aborts during a check", async () => {
    const controller = new AbortController();
    await createApp({
      plugins: defineJuniorPlugins([
        defineJuniorPlugin({
          manifest: {
            name: "slow-check",
            displayName: "Slow check",
            description: "Aborted mid-check.",
          },
          hooks: {
            afterToolExecute(ctx) {
              controller.abort();
              ctx.signal?.throwIfAborted();
            },
          },
        }),
      ]),
    });
    const { tool } = editTool(fakeSandbox(""));

    await expect(
      tool.execute("call-4", { path: "src/a.ts" }, controller.signal),
    ).resolves.toEqual({
      content: [{ type: "text", text: '{"ok":true}' }],
      details: { ok: true },
    });
  });
});
