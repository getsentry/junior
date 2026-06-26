import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { describe, expect, it, vi } from "vitest";
import { loadCliPluginCommands } from "@/cli/plugins";
import { defineJuniorPlugins, type JuniorPluginSet } from "@/plugins";

const pluginSetRef = vi.hoisted(() => ({
  current: undefined as JuniorPluginSet | undefined,
}));

vi.mock("@/plugin-module", () => ({
  loadAppPluginSet: vi.fn(async () => pluginSetRef.current),
}));

function fakeIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stderr: {
        write(text: string) {
          stderr.push(text);
        },
      },
      stdout: {
        write(text: string) {
          stdout.push(text);
        },
      },
      writeError(text: string) {
        stderr.push(text);
      },
      writeOutput(text: string) {
        stdout.push(text);
      },
    },
    stderr,
    stdout,
  };
}

describe("plugin CLI commands", () => {
  it("dispatches a Commander-configured plugin subcommand with Junior context", async () => {
    pluginSetRef.current = defineJuniorPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "echo",
          displayName: "Echo",
          description: "Echo plugin",
        },
        cli: {
          commands: [
            {
              name: "echo",
              summary: "Echo test command",
              configure(command, junior) {
                command
                  .command("say")
                  .argument("[words...]", "Words to echo")
                  .action(
                    junior.action(async (ctx, words) => {
                      await ctx.io.writeOutput(
                        `${(words as string[]).join(" ")}:${ctx.plugin.name}\n`,
                      );
                      return 7;
                    }),
                  );
              },
            },
          ],
        },
      }),
    ]);
    const dispatcher = await loadCliPluginCommands();
    const { io, stderr, stdout } = fakeIo();

    await expect(
      dispatcher.run("echo", ["say", "hello", "world"], io),
    ).resolves.toBe(7);

    expect(stdout.join("")).toBe("hello world:echo\n");
    expect(stderr.join("")).toBe("");
  });

  it("rejects plugin commands that do not define subcommands", async () => {
    pluginSetRef.current = defineJuniorPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "empty",
          displayName: "Empty",
          description: "Empty plugin",
        },
        cli: {
          commands: [
            {
              name: "empty",
              summary: "Empty command",
              configure() {},
            },
          ],
        },
      }),
    ]);

    await expect(loadCliPluginCommands()).rejects.toThrow(
      'Plugin CLI command "empty" from plugin "empty" must define at least one subcommand',
    );
  });

  it("rejects plugin commands that rename their top-level namespace", async () => {
    pluginSetRef.current = defineJuniorPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "memory",
          displayName: "Memory",
          description: "Memory plugin",
        },
        cli: {
          commands: [
            {
              name: "memory",
              summary: "Memory command",
              configure(command) {
                command.name("renamed");
                command.command("search");
              },
            },
          ],
        },
      }),
    ]);

    await expect(loadCliPluginCommands()).rejects.toThrow(
      'Plugin CLI command "memory" from plugin "memory" must not rename its top-level command',
    );
  });
});
