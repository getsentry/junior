import { beforeEach, describe, expect, it, vi } from "vitest";
import { maybeExecuteJrRpcCustomCommand } from "@/chat/capabilities/jr-rpc-command";
import { createChannelConfigurationService } from "@/chat/configuration/service";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import type { Skill } from "@/chat/skills";

const activeSkill: Skill = {
  name: "github",
  description: "Issue helper",
  skillPath: "/tmp/github",
  body: "instructions",
  pluginProvider: "github",
};

function makeChannelConfiguration() {
  let state: Record<string, unknown> | null = null;
  return createChannelConfigurationService({
    load: async () => state,
    save: async (next) => {
      state = {
        ...(state ?? {}),
        configuration: next,
      };
    },
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
    const result = await maybeExecuteJrRpcCustomCommand("echo hi", {
      activeSkill,
    });
    expect(result).toEqual({ handled: false });
  });

  it("requires conversation context for config commands", async () => {
    const result = await maybeExecuteJrRpcCustomCommand(
      "jr-rpc config get github.repo",
      {
        activeSkill,
        requesterId: "U123",
      },
    );

    const handled = expectHandled(result);
    expect(handled.result.exit_code).toBe(1);
    expect(handled.result.stderr).toContain(
      "jr-rpc config commands require active conversation context",
    );
  });

  it("sets and gets configuration values", async () => {
    const configuration = makeChannelConfiguration();
    const onConfigurationValueChanged = vi.fn();

    const setResult = await maybeExecuteJrRpcCustomCommand(
      "jr-rpc config set github.repo getsentry/junior",
      {
        activeSkill,
        channelConfiguration: configuration,
        requesterId: "U123",
        onConfigurationValueChanged,
      },
    );
    expect(expectHandled(setResult).result.exit_code).toBe(0);
    expect(onConfigurationValueChanged).toHaveBeenCalledWith(
      "github.repo",
      "getsentry/junior",
    );

    const getResult = await maybeExecuteJrRpcCustomCommand(
      "jr-rpc config get github.repo",
      {
        activeSkill,
        channelConfiguration: configuration,
        requesterId: "U123",
      },
    );
    const handled = expectHandled(getResult);
    expect(handled.result.exit_code).toBe(0);
    expect(JSON.parse(handled.result.stdout)).toMatchObject({
      ok: true,
      key: "github.repo",
      value: "getsentry/junior",
    });
  });

  it("supports config list with a prefix filter", async () => {
    const configuration = makeChannelConfiguration();
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
      {
        activeSkill,
        channelConfiguration: configuration,
        requesterId: "U123",
      },
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
    const previousConfig = pluginCatalogRuntime.setConfig({
      inlineManifests: [
        {
          manifest: {
            name: "example",
            displayName: "Example",
            description: "Example plugin",
            capabilities: ["example.search"],
            configKeys: ["example.repo"],
          },
        },
      ],
    });
    try {
      const result = await maybeExecuteJrRpcCustomCommand(
        "jr-rpc plugins list",
        {
          activeSkill,
        },
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
            capabilities: ["example.search"],
            configKeys: ["example.repo"],
          },
        ]),
      );
    } finally {
      pluginCatalogRuntime.setConfig(previousConfig);
    }
  });

  it("unsets configuration values", async () => {
    const configuration = makeChannelConfiguration();
    const onConfigurationValueChanged = vi.fn();

    await configuration.set({
      key: "github.repo",
      value: "getsentry/junior",
      updatedBy: "U123",
      source: "test",
    });

    const result = await maybeExecuteJrRpcCustomCommand(
      "jr-rpc config unset github.repo",
      {
        activeSkill,
        channelConfiguration: configuration,
        requesterId: "U123",
        onConfigurationValueChanged,
      },
    );
    const handled = expectHandled(result);
    expect(handled.result.exit_code).toBe(0);
    expect(JSON.parse(handled.result.stdout)).toMatchObject({
      ok: true,
      key: "github.repo",
      deleted: true,
    });
    expect(onConfigurationValueChanged).toHaveBeenCalledWith(
      "github.repo",
      undefined,
    );
  });

  it("warns when setting an unrecognized config key", async () => {
    const previousConfig = pluginCatalogRuntime.setConfig({
      inlineManifests: [
        {
          manifest: {
            name: "cloudflare",
            displayName: "Cloudflare",
            description: "Cloudflare plugin",
            capabilities: [],
            configKeys: ["cloudflare.account.id", "cloudflare.zone.id", "cloudflare.worker.name"],
          },
        },
      ],
    });
    try {
      const configuration = makeChannelConfiguration();
      const result = await maybeExecuteJrRpcCustomCommand(
        "jr-rpc config set cloudflare.worker-id sentry-mcp",
        {
          activeSkill,
          channelConfiguration: configuration,
          requesterId: "U123",
        },
      );
      const handled = expectHandled(result);
      // Still succeeds
      expect(handled.result.exit_code).toBe(0);
      // But warns about the unrecognized key with suggestions
      expect(handled.result.stderr).toContain(
        '"cloudflare.worker-id" is not a recognized config key',
      );
      expect(handled.result.stderr).toContain("cloudflare.worker.name");
    } finally {
      pluginCatalogRuntime.setConfig(previousConfig);
    }
  });

  it("does not warn when setting a recognized config key", async () => {
    const previousConfig = pluginCatalogRuntime.setConfig({
      inlineManifests: [
        {
          manifest: {
            name: "cloudflare",
            displayName: "Cloudflare",
            description: "Cloudflare plugin",
            capabilities: [],
            configKeys: ["cloudflare.account.id", "cloudflare.zone.id", "cloudflare.worker.name"],
          },
        },
      ],
    });
    try {
      const configuration = makeChannelConfiguration();
      const result = await maybeExecuteJrRpcCustomCommand(
        "jr-rpc config set cloudflare.worker.name sentry-mcp",
        {
          activeSkill,
          channelConfiguration: configuration,
          requesterId: "U123",
        },
      );
      const handled = expectHandled(result);
      expect(handled.result.exit_code).toBe(0);
      expect(handled.result.stderr).toBe("");
    } finally {
      pluginCatalogRuntime.setConfig(previousConfig);
    }
  });
});