import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { describe, expect, it } from "vitest";
import {
  createAgentPluginHookRunner,
  setAgentPlugins,
} from "@/chat/plugins/agent-hooks";
import type { SandboxInstance } from "@/chat/sandbox/workspace";

function fakeSandbox(
  writes: Array<{ content: string | Uint8Array; path: string }>,
): SandboxInstance {
  return {
    sandboxId: "sandbox-agent-hooks",
    sandboxEgressId: "session-agent-hooks",
    fs: {
      async readFile() {
        return "";
      },
      async writeFile() {},
      async readdir() {
        return [];
      },
      async stat() {
        return { isDirectory: () => false };
      },
    },
    async extendTimeout() {},
    async mkDir() {},
    async readFileToBuffer() {
      return null;
    },
    async runCommand() {
      return {
        exitCode: 0,
        async stdout() {
          return "";
        },
        async stderr() {
          return "";
        },
      };
    },
    async snapshot() {
      return { snapshotId: "snapshot-agent-hooks" };
    },
    async stop() {},
    async update() {},
    async writeFiles(files) {
      writes.push(
        ...files.map((file) => ({
          path: file.path,
          content: file.content,
        })),
      );
    },
  };
}

describe("agent plugin hooks", () => {
  it("runs sandbox and tool lifecycle hooks from configured plugins", async () => {
    const writes: Array<{ content: string | Uint8Array; path: string }> = [];
    const previous = setAgentPlugins([
      defineJuniorPlugin({
        name: "agent-demo",
        hooks: {
          async sandboxPrepare(ctx) {
            await ctx.sandbox.writeFile({
              path: `${ctx.sandbox.juniorRoot}/prepared.txt`,
              content: ctx.requester?.userId ?? "",
            });
          },
          beforeToolExecute(ctx) {
            ctx.env.set("AGENT_PLUGIN", ctx.requester?.userId ?? "");
            if (
              typeof ctx.tool.input === "object" &&
              ctx.tool.input &&
              "command" in ctx.tool.input &&
              ctx.tool.input.command === "replace me"
            ) {
              ctx.decision.replaceInput({
                ...ctx.tool.input,
                command: "replaced",
              });
            }
            if (
              typeof ctx.tool.input === "object" &&
              ctx.tool.input &&
              "command" in ctx.tool.input &&
              ctx.tool.input.command === "blocked"
            ) {
              ctx.decision.deny("blocked by plugin");
            }
          },
        },
      }),
    ]);
    try {
      const runner = createAgentPluginHookRunner({
        requester: { userId: "U123" },
      });

      await runner.prepareSandbox(fakeSandbox(writes));
      expect(writes).toEqual([
        {
          path: "/vercel/sandbox/.junior/prepared.txt",
          content: "U123",
        },
      ]);

      await expect(
        runner.beforeToolExecute({
          name: "bash",
          input: { command: "blocked" },
        }),
      ).rejects.toThrow("blocked by plugin");

      const before = await runner.beforeToolExecute({
        name: "bash",
        input: { command: "replace me" },
      });
      expect(before.input).toEqual({
        command: "replaced",
        env: { AGENT_PLUGIN: "U123" },
      });
      expect(before.env).toEqual({ AGENT_PLUGIN: "U123" });
    } finally {
      setAgentPlugins(previous);
    }
  });
});
