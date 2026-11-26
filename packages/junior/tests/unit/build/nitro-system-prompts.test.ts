import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginRegistration } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installChatConfig } from "@/chat/config";
import { loadConfig } from "@/config";
import { getPluginSystemPromptContributions } from "@/chat/plugins/system-prompt-hook";
import { buildPluginSystemPromptContributions } from "@/chat/prompt";
import { buildDeploymentSystemPrompt } from "@/chat/system-prompt";
import type { PromptMode } from "@/chat/system-prompt-rules";
import type { SystemPromptTable } from "@/chat/system-prompt-table";
import { juniorNitro, type JuniorNitroOptions } from "@/nitro";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "junior-nitro-system-prompts-"),
  );
  tempDirs.push(tempDir);
  return tempDir;
}

const PROMPT_MODES: PromptMode[] = [
  "automation",
  "child_agent",
  "conversation",
  "lead",
  "thread",
];

/** Write `plugins.mjs` with one plugin that has the `systemPrompt` hook body. */
async function writeSystemPromptPlugin(
  tempRoot: string,
  hookBody: string,
): Promise<string> {
  const file = path.join(tempRoot, "plugins.mjs");
  await fs.writeFile(
    file,
    [
      "export const plugins = {",
      "  packageNames: [],",
      "  registrations: [{",
      '    manifest: { name: "demo", displayName: "Demo", description: "Demo" },',
      `    hooks: { systemPrompt(ctx) { ${hookBody} } },`,
      "  }],",
      "};",
      "",
    ].join("\n"),
    "utf8",
  );
  return file;
}

/** Render the virtual modules that `juniorNitro` injects at build. */
async function renderBuild(
  tempRoot: string,
  options: JuniorNitroOptions = {},
): Promise<{ config: string; systemPrompts: string }> {
  const virtual: Record<string, (() => Promise<string>) | string> = {};
  await juniorNitro({ plugins: "./plugins", ...options }).nitro.setup({
    hooks: { hook() {} },
    options: {
      output: { serverDir: path.join(tempRoot, ".output", "server") },
      rootDir: tempRoot,
      vercel: {},
      virtual,
    },
  });
  const render = async (id: string) => {
    const template = virtual[id];
    if (template === undefined) {
      throw new Error(`juniorNitro did not inject ${id}`);
    }
    return typeof template === "function" ? template() : template;
  };
  const systemPrompts = await render("#junior/system-prompts");
  return { config: await render("#junior/config"), systemPrompts };
}

/** Render `#junior/system-prompts` as `juniorNitro` does at build. */
async function renderSystemPrompts(tempRoot: string): Promise<string> {
  return (await renderBuild(tempRoot)).systemPrompts;
}

/** Import a rendered `#junior/system-prompts` module. */
async function importSystemPrompts(code: string): Promise<SystemPromptTable> {
  const built: { systemPrompts: SystemPromptTable } = await import(
    `data:text/javascript,${encodeURIComponent(code)}`
  );
  return built.systemPrompts;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const tempDir of tempDirs.splice(0)) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

describe("juniorNitro system prompts", () => {
  it("renders the same system prompts at build as the runtime builds", async () => {
    const tempRoot = await makeTempDir();
    const file = await writeSystemPromptPlugin(
      tempRoot,
      "return [{ text: `Demo guidance for ${ctx.platform}` }];",
    );
    const systemPrompts = await importSystemPrompts(
      await renderSystemPrompts(tempRoot),
    );
    const pluginModule: {
      plugins: { registrations: PluginRegistration[] };
    } = await import(pathToFileURL(file).href);

    for (const platform of ["slack", "local"] as const) {
      const guidance = buildPluginSystemPromptContributions(
        await getPluginSystemPromptContributions(
          pluginModule.plugins.registrations,
          platform,
        ),
      );
      for (const mode of PROMPT_MODES) {
        const sections = systemPrompts[platform][mode];
        // The runtime here has no app plugins, so it builds only the core
        // blocks.
        expect(
          sections
            .slice(0, -1)
            .map((section) => section.text)
            .join("\n\n"),
        ).toBe(await buildDeploymentSystemPrompt(platform, mode));
        expect(sections.at(-1)).toEqual({ name: "plugins", text: guidance });
      }
    }
  });

  it("builds the system prompts and the runtime bot name from juniorNitro({ botName })", async () => {
    const tempRoot = await makeTempDir();
    await writeSystemPromptPlugin(tempRoot, "return [];");
    vi.stubEnv("JUNIOR_BOT_NAME", "junior");
    const named = await renderBuild(tempRoot, { botName: "jr" });
    const unnamed = await importSystemPrompts(
      await renderSystemPrompts(tempRoot),
    );
    const table = await importSystemPrompts(named.systemPrompts);
    const identity = (sections: { name: string; text: string }[]) =>
      sections.find((section) => section.name === "identity");

    expect(named.config).toContain('export const botName = "jr";');
    const previousConfig = installChatConfig(
      loadConfig({ env: process.env, options: { bot: { userName: "jr" } } }),
    );
    try {
      for (const platform of ["slack", "local"] as const) {
        const sections = table[platform].conversation;
        // The runtime builds the same prompt when its bot name is `jr`.
        expect(sections.map((section) => section.text).join("\n\n")).toBe(
          await buildDeploymentSystemPrompt(platform, "conversation"),
        );
        expect(identity(sections)).not.toEqual(
          identity(unnamed[platform].conversation),
        );
      }
    } finally {
      installChatConfig(previousConfig);
    }
  });

  it("fails the build when a systemPrompt hook throws", async () => {
    const tempRoot = await makeTempDir();
    await writeSystemPromptPlugin(tempRoot, 'throw new Error("no guidance");');

    await expect(renderSystemPrompts(tempRoot)).rejects.toThrow(
      'Plugin "demo" systemPrompt hook failed',
    );
  });

  it("fails the build when SOUL.md exists but can't be read", async () => {
    const tempRoot = await fs.realpath(await makeTempDir());
    await writeSystemPromptPlugin(tempRoot, "return [];");
    const soulPath = path.join(tempRoot, "app", "SOUL.md");
    // A directory where the file should be gives a read error other than
    // "not found", as a file that the build user can't read does.
    await fs.mkdir(soulPath, { recursive: true });
    const originalCwd = process.cwd();
    process.chdir(tempRoot);
    try {
      await expect(renderSystemPrompts(tempRoot)).rejects.toThrow(
        `SOUL.md at ${soulPath} can't be read`,
      );
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("fails the build when SOUL.md is empty", async () => {
    const tempRoot = await fs.realpath(await makeTempDir());
    await writeSystemPromptPlugin(tempRoot, "return [];");
    await fs.mkdir(path.join(tempRoot, "app"));
    const soulPath = path.join(tempRoot, "app", "SOUL.md");
    await fs.writeFile(soulPath, " \n\t\n");
    const originalCwd = process.cwd();
    process.chdir(tempRoot);
    try {
      await expect(renderSystemPrompts(tempRoot)).rejects.toThrow(
        `SOUL.md at ${soulPath} is empty`,
      );
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("builds the default personality when SOUL.md is missing", async () => {
    const tempRoot = await fs.realpath(await makeTempDir());
    await writeSystemPromptPlugin(tempRoot, "return [];");
    await fs.mkdir(path.join(tempRoot, "app"));
    await fs.writeFile(path.join(tempRoot, "app", "WORLD.md"), "World\n");
    const originalCwd = process.cwd();
    process.chdir(tempRoot);
    try {
      const systemPrompts = await importSystemPrompts(
        await renderSystemPrompts(tempRoot),
      );
      const sections = systemPrompts.local.conversation;
      expect(sections.map((section) => section.name)).toContain("world");
      // With no SOUL.md, the runtime also uses the default personality.
      expect(sections.map((section) => section.text).join("\n\n")).toBe(
        await buildDeploymentSystemPrompt("local", "conversation"),
      );
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("runs each systemPrompt hook once per platform with no db, cache or mode", async () => {
    const tempRoot = await makeTempDir();
    await writeSystemPromptPlugin(
      tempRoot,
      [
        "(globalThis.__juniorSystemPromptCalls ??= []).push({",
        "  keys: Object.keys(ctx).sort(),",
        "  platform: ctx.platform,",
        "});",
        "return [];",
      ].join(" "),
    );
    const globalState = globalThis as typeof globalThis & {
      __juniorSystemPromptCalls?: unknown[];
    };
    delete globalState.__juniorSystemPromptCalls;

    try {
      await renderSystemPrompts(tempRoot);
      expect(globalState.__juniorSystemPromptCalls).toEqual(
        expect.arrayContaining([
          { keys: ["log", "platform", "plugin"], platform: "slack" },
          { keys: ["log", "platform", "plugin"], platform: "local" },
        ]),
      );
      expect(globalState.__juniorSystemPromptCalls).toHaveLength(2);
    } finally {
      delete globalState.__juniorSystemPromptCalls;
    }
  });

  it("throws in a juniorNitro build that has no system prompts module", async () => {
    vi.doMock("#junior/config", () => ({}));
    try {
      await expect(
        buildDeploymentSystemPrompt("slack", "conversation"),
      ).rejects.toThrow(
        "#junior/system-prompts is missing from this juniorNitro() build",
      );
    } finally {
      vi.doUnmock("#junior/config");
    }
  });
});
