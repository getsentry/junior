import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, defineJuniorPlugins } from "@/app";
import { setConfigDefaults } from "@/chat/configuration/defaults";
import {
  getLoadedEventBindings,
  loadEventPromptRegistry,
} from "@/chat/events/registry";
import { setAgentPlugins } from "@/chat/plugins/agent-hooks";
import { setPluginCatalogConfig } from "@/chat/plugins/registry";

const originalCwd = process.cwd();
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "junior-event-prompts-app-"),
  );
  tempDirs.push(tempDir);
  return tempDir;
}

async function writeEventBinding(
  root: string,
  fileName: string,
  lines: string[],
): Promise<void> {
  const eventsDir = path.join(root, "app", "events", "slack");
  await fs.mkdir(eventsDir, { recursive: true });
  await fs.writeFile(path.join(eventsDir, fileName), lines.join("\n"), "utf8");
}

async function resetEventRegistry(): Promise<void> {
  const emptyRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "junior-event-prompts-empty-"),
  );
  tempDirs.push(emptyRoot);
  await loadEventPromptRegistry(emptyRoot);
}

describe("event prompt app configuration", () => {
  beforeEach(async () => {
    setAgentPlugins([]);
    setPluginCatalogConfig(undefined);
    setConfigDefaults(undefined);
    await resetEventRegistry();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    setAgentPlugins([]);
    setPluginCatalogConfig(undefined);
    setConfigDefaults(undefined);
    await resetEventRegistry();
    for (const tempDir of tempDirs.splice(0)) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("loads install-owned Markdown event bindings during app creation", async () => {
    const root = await makeTempDir();
    await writeEventBinding(root, "root-channel.md", [
      "---",
      "id: slack-root-channel",
      "event: slack.channel.message.created",
      "scope:",
      "  channelId: C123",
      "context:",
      "  include:",
      "    - source_message",
      "---",
      "",
      "Review this channel message.",
      "",
    ]);
    process.chdir(root);

    await createApp({ plugins: defineJuniorPlugins([]) });
    const bindingPath = await fs.realpath(
      path.join(root, "app", "events", "slack", "root-channel.md"),
    );

    expect(getLoadedEventBindings()).toMatchObject([
      {
        id: "slack-root-channel",
        event: "slack.channel.message.created",
        path: bindingPath,
        scope: { channelId: "C123" },
        contextInclude: ["source_message"],
        body: "Review this channel message.",
      },
    ]);
  });

  it("fails startup when install-owned event bindings are invalid", async () => {
    const root = await makeTempDir();
    await writeEventBinding(root, "bad-context.md", [
      "---",
      "id: slack-bad-context",
      "event: slack.channel.message.created",
      "context:",
      "  include:",
      "    - missing_context",
      "---",
      "",
      "Review this channel message.",
      "",
    ]);
    process.chdir(root);

    await expect(
      createApp({ plugins: defineJuniorPlugins([]) }),
    ).rejects.toThrow(
      'event binding "slack-bad-context" references unsupported context block "missing_context"',
    );
    expect(getLoadedEventBindings()).toEqual([]);
  });
});
