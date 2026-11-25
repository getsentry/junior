import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

// This file imports no Junior code at the top. Each test file gets its own
// modules, so the build path loads here for the first time, after the mock.

const tempDirs: string[] = [];

afterEach(async () => {
  vi.doUnmock("@/chat/config");
  vi.unstubAllEnvs();
  for (const tempDir of tempDirs.splice(0)) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

it("builds the virtual modules without runtime configuration", async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "junior-nitro-build-env-"),
  );
  tempDirs.push(tempRoot);
  await fs.writeFile(
    path.join(tempRoot, "plugins.mjs"),
    "export const plugins = { packageNames: [], registrations: [] };\n",
    "utf8",
  );
  vi.stubEnv("DATABASE_URL", undefined);
  vi.stubEnv("JUNIOR_ENCRYPTION_KEYS", undefined);
  vi.doMock("@/chat/config", () => {
    throw new Error("The build loaded @/chat/config");
  });
  const { juniorNitro } = await import("@/nitro");
  const virtual: Record<string, (() => Promise<string>) | string> = {};

  await juniorNitro({ botName: "jr", plugins: "./plugins" }).nitro.setup({
    hooks: { hook() {} },
    options: {
      output: { serverDir: path.join(tempRoot, ".output", "server") },
      rootDir: tempRoot,
      vercel: {},
      virtual,
    },
  });
  const rendered = await Promise.all(
    ["#junior/config", "#junior/system-prompts"].map(async (id) => {
      const template = virtual[id];
      return typeof template === "function" ? template() : template;
    }),
  );

  expect(rendered).toEqual([
    expect.stringContaining('export const botName = "jr";'),
    expect.stringContaining("export const systemPrompts = "),
  ]);
});
