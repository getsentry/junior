import { beforeEach, describe, expect, it, vi } from "vitest";
import { maybeExecuteJrRpcCustomCommand } from "@/chat/capabilities/jr-rpc-command";
import { createLocationConfigurationService } from "@/chat/configuration/service";
import type { ConfigEntry } from "@/chat/configuration/types";
import { useAppContext } from "../../fixtures/app-context";

function makeLocationConfiguration() {
  const entries = new Map<string, ConfigEntry>();
  return createLocationConfigurationService({
    get: async (key) => entries.get(key),
    list: async () => [...entries.values()],
    set: async (entry) => {
      entries.set(entry.key, entry);
    },
    unset: async (key) => entries.delete(key),
  });
}

function expectHandled(
  result: Awaited<ReturnType<typeof maybeExecuteJrRpcCustomCommand>>,
) {
  expect(result.handled).toBe(true);
  if (!result.handled) {
    throw new Error("Expected jr-rpc command to be handled");
  }
  return result;
}

describe("jr-rpc custom command", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("does not handle non jr-rpc commands", async () => {
    const result = await maybeExecuteJrRpcCustomCommand("echo hi", {});
    expect(result).toEqual({ handled: false });
  });

  it("rejects jr-rpc chained after other shell steps", async () => {
    const chained = expectHandled(
      await maybeExecuteJrRpcCustomCommand(
        "cd /vercel/sandbox && jr-rpc config get github.repo",
        {},
      ),
    );
    expect(chained.result.exit_code).toBe(2);
    expect(chained.result.stderr).toContain("standalone");

    const mention = await maybeExecuteJrRpcCustomCommand(
      "grep -rn jr-rpc src",
      {},
    );
    expect(mention).toEqual({ handled: false });
  });

  it("passes quoted values as plain arguments", async () => {
    // `config get` echoes the key it got.
    for (const [command, key] of [
      [`jr-rpc config get '["junior","relay"]'`, '["junior","relay"]'],
      ['jr-rpc config get "a \\"b\\" c"', 'a "b" c'],
      ["jr-rpc config get a\\ b", "a b"],
    ] as const) {
      const handled = expectHandled(
        await maybeExecuteJrRpcCustomCommand(command, {
          locationConfiguration: makeLocationConfiguration(),
        }),
      );
      expect(handled.result.exit_code).toBe(0);
      expect(JSON.parse(handled.result.stdout)).toMatchObject({ key });
    }
  });

  it("names the shell part to remove", async () => {
    for (const [command, part] of [
      ["jr-rpc config get $HOME", "$HOME"],
      ["jr-rpc config get $(id)", "$(id)"],
      ["jr-rpc config get `id`", "`id`"],
      ["jr-rpc config get *.repo", "*.repo"],
      ["jr-rpc config get github.repo # note", "# note"],
      ["jr-rpc config get github.repo && echo hi", "&& echo hi"],
      ["jr-rpc config get github.repo > out.txt", "> out.txt"],
      ["jr-rpc config get github.repo | jq .", "| jq ."],
      ["jr-rpc config get github.repo 2>&1", "2>&1"],
    ] as const) {
      const handled = expectHandled(
        await maybeExecuteJrRpcCustomCommand(command, {
          locationConfiguration: makeLocationConfiguration(),
        }),
      );
      expect(handled.result).toMatchObject({
        exit_code: 2,
        stdout: "",
        stderr: `jr-rpc takes plain arguments only. Remove "${part}" and run the jr-rpc command again.\n`,
      });
    }
  });

  it("requires conversation context for config commands", async () => {
    const result = await maybeExecuteJrRpcCustomCommand(
      "jr-rpc config get github.repo",
      {},
    );

    const handled = expectHandled(result);
    expect(handled.result.exit_code).toBe(1);
    expect(handled.result.stderr).toContain(
      "jr-rpc config commands require active conversation context",
    );
  });

  it("gets configuration values", async () => {
    const configuration = makeLocationConfiguration();
    await configuration.set({ key: "github.repo", value: "getsentry/junior" });

    const getResult = await maybeExecuteJrRpcCustomCommand(
      "jr-rpc config get github.repo",
      { locationConfiguration: configuration },
    );
    const handled = expectHandled(getResult);
    expect(handled.result.exit_code).toBe(0);
    // just-bash froze these host globals on its first command.
    expect(Object.isFrozen(Math)).toBe(false);
    expect(Object.isFrozen(JSON)).toBe(false);
    expect(Object.isFrozen(Reflect)).toBe(false);
    expect(JSON.parse(handled.result.stdout)).toMatchObject({
      ok: true,
      key: "github.repo",
      scope: "location",
      value: "getsentry/junior",
    });
  });

  it("points set and unset to the setConfiguration tool", async () => {
    const configuration = makeLocationConfiguration();
    for (const command of [
      "jr-rpc config set github.repo getsentry/junior",
      "jr-rpc config unset github.repo",
    ]) {
      const handled = expectHandled(
        await maybeExecuteJrRpcCustomCommand(command, {
          locationConfiguration: configuration,
        }),
      );
      expect(handled.result.exit_code).toBe(2);
      expect(handled.result.stderr).toContain("setConfiguration");
    }
    expect(await configuration.list()).toEqual([]);
  });

  it("supports config list with a prefix filter", async () => {
    const configuration = makeLocationConfiguration();
    await configuration.set({
      key: "github.repo",
      value: "getsentry/junior",
      updatedBy: "U123",
      source: "test",
    });
    await configuration.set({
      key: "sentry.org",
      value: "getsentry",
      updatedBy: "U123",
      source: "test",
    });

    const result = await maybeExecuteJrRpcCustomCommand(
      "jr-rpc config list --prefix github.",
      { locationConfiguration: configuration },
    );
    const handled = expectHandled(result);
    expect(handled.result.exit_code).toBe(0);
    expect(JSON.parse(handled.result.stdout)).toMatchObject({
      ok: true,
      entries: [
        expect.objectContaining({
          key: "github.repo",
          value: "getsentry/junior",
        }),
      ],
    });
  });

  it("lists installed plugins", async () => {
    useAppContext({
      pluginConfig: {
        inlineManifests: [
          {
            manifest: {
              name: "example",
              displayName: "Example",
              description: "Example plugin",
              configKeys: ["example.repo"],
            },
          },
        ],
      },
    });
    const result = await maybeExecuteJrRpcCustomCommand(
      "jr-rpc plugins list",
      {},
    );
    const handled = expectHandled(result);
    expect(handled.result.exit_code).toBe(0);
    const output = JSON.parse(handled.result.stdout);
    expect(output.ok).toBe(true);
    expect(output.plugins).toEqual(
      expect.arrayContaining([
        {
          name: "example",
          displayName: "Example",
          description: "Example plugin",
          configKeys: ["example.repo"],
        },
      ]),
    );
  });
});
