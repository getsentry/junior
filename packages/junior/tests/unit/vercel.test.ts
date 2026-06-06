import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveConversationWorkVisibilityTimeoutSeconds } from "@/chat/task-execution/vercel-callback";
import { juniorVercelConfig } from "@/vercel";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(TEST_DIR, "../../../..");

describe("juniorVercelConfig", () => {
  it("returns config with default buildCommand", () => {
    const config = juniorVercelConfig();

    expect(config.framework).toBe("nitro");
    expect(config.buildCommand).toBe("pnpm build");
    expect(config.crons).toBeUndefined();
    expect(config.functions).toBeUndefined();
  });

  it("omits buildCommand when set to null", () => {
    const config = juniorVercelConfig({ buildCommand: null });

    expect(config.buildCommand).toBeUndefined();
  });

  it("keeps the example app Vercel config aligned with the root project config", () => {
    const config = JSON.parse(
      fs.readFileSync(
        path.join(WORKSPACE_ROOT, "apps/example/vercel.json"),
        "utf8",
      ),
    );

    expect(config).toEqual(juniorVercelConfig());
  });

  it("keeps queue triggers out of the root Vercel source-function config", () => {
    const config = juniorVercelConfig();

    expect(config.functions).toBeUndefined();
  });
});

describe("resolveConversationWorkVisibilityTimeoutSeconds", () => {
  it("keeps queue redelivery past the function timeout boundary", () => {
    expect(resolveConversationWorkVisibilityTimeoutSeconds(300)).toBe(330);
  });
});
