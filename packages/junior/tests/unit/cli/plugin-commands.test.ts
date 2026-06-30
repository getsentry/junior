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

  it("rejects plugin commands that add top-level aliases", async () => {
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
                command.alias("mem");
                command.command("search");
              },
            },
          ],
        },
      }),
    ]);

    await expect(loadCliPluginCommands()).rejects.toThrow(
      'Plugin CLI command "memory" from plugin "memory" must not define top-level aliases',
    );
  });

  it("rejects plugin commands that conflict with core commands", async () => {
    pluginSetRef.current = defineJuniorPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "shadow",
          displayName: "Shadow",
          description: "Shadow plugin",
        },
        cli: {
          commands: [
            {
              name: "chat",
              summary: "Shadow chat",
              configure(command) {
                command.command("run");
              },
            },
          ],
        },
      }),
    ]);

    await expect(loadCliPluginCommands()).rejects.toThrow(
      'Plugin CLI command "chat" from plugin "shadow" conflicts with a core command',
    );
  });

  it("rejects plugin commands with invalid names", async () => {
    pluginSetRef.current = defineJuniorPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "invalid",
          displayName: "Invalid",
          description: "Invalid plugin",
        },
        cli: {
          commands: [
            {
              name: "Memory",
              summary: "Invalid memory",
              configure(command) {
                command.command("search");
              },
            },
          ],
        },
      }),
    ]);

    await expect(loadCliPluginCommands()).rejects.toThrow(
      'Plugin CLI command "Memory" from plugin "invalid" must be a lowercase command identifier',
    );
  });

  it("rejects plugin commands without a configure function", async () => {
    pluginSetRef.current = defineJuniorPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "broken",
          displayName: "Broken",
          description: "Broken plugin",
        },
        cli: {
          commands: [
            {
              name: "broken",
              summary: "Broken command",
              configure: undefined,
            } as never,
          ],
        },
      }),
    ]);

    await expect(loadCliPluginCommands()).rejects.toThrow(
      'Plugin CLI command "broken" from plugin "broken" must define a configure function',
    );
  });

  it("rejects duplicate plugin command names", async () => {
    pluginSetRef.current = defineJuniorPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "first",
          displayName: "First",
          description: "First plugin",
        },
        cli: {
          commands: [
            {
              name: "memory",
              summary: "First memory",
              configure(command) {
                command.command("search");
              },
            },
          ],
        },
      }),
      defineJuniorPlugin({
        manifest: {
          name: "second",
          displayName: "Second",
          description: "Second plugin",
        },
        cli: {
          commands: [
            {
              name: "memory",
              summary: "Second memory",
              configure(command) {
                command.command("show");
              },
            },
          ],
        },
      }),
    ]);

    await expect(loadCliPluginCommands()).rejects.toThrow(
      'Plugin CLI command "memory" from plugin "second" conflicts with plugin "first"',
    );
  });

  it("can load valid plugin commands after configured command validation fails", async () => {
    pluginSetRef.current = defineJuniorPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "broken",
          displayName: "Broken",
          description: "Broken plugin",
        },
        cli: {
          commands: [
            {
              name: "broken",
              summary: "Broken command",
              configure() {},
            },
          ],
        },
      }),
    ]);
    await expect(loadCliPluginCommands()).rejects.toThrow(
      'Plugin CLI command "broken" from plugin "broken" must define at least one subcommand',
    );

    pluginSetRef.current = defineJuniorPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "valid",
          displayName: "Valid",
          description: "Valid plugin",
        },
        cli: {
          commands: [
            {
              name: "valid",
              summary: "Valid command",
              configure(command, junior) {
                command.command("run").action(
                  junior.action(async (ctx) => {
                    await ctx.io.writeOutput(`${ctx.plugin.name}\n`);
                  }),
                );
              },
            },
          ],
        },
      }),
    ]);
    const dispatcher = await loadCliPluginCommands();
    const { io, stdout } = fakeIo();

    await expect(dispatcher.run("valid", ["run"], io)).resolves.toBe(0);

    expect(stdout.join("")).toBe("valid\n");
  });
});
