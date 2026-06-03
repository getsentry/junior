import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveConversationWorkVisibilityTimeoutSeconds } from "@/chat/task-execution/vercel-callback";
import { DEFAULT_CONVERSATION_WORK_QUEUE_TOPIC } from "@/chat/task-execution/vercel-queue";
import { juniorVercelConfig } from "@/vercel";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(TEST_DIR, "../../../..");

describe("juniorVercelConfig", () => {
  it("returns config with default buildCommand", () => {
    const config = juniorVercelConfig();

    expect(config.framework).toBe("nitro");
    expect(config.buildCommand).toBe("pnpm build");
    expect(config.crons).toEqual([
      {
        path: "/api/internal/heartbeat",
        schedule: "* * * * *",
      },
    ]);
    expect(config.functions).toEqual({
      "api/internal/agent/continue.ts": {
        maxDuration: 300,
        experimentalTriggers: [
          {
            type: "queue/v2beta",
            topic: DEFAULT_CONVERSATION_WORK_QUEUE_TOPIC,
          },
        ],
      },
    });
  });

  it("omits buildCommand when set to null", () => {
    const config = juniorVercelConfig({ buildCommand: null });

    expect(config.buildCommand).toBeUndefined();
  });

  it("keeps the example app Vercel config aligned with queue triggers", () => {
    const config = JSON.parse(
      fs.readFileSync(
        path.join(WORKSPACE_ROOT, "apps/example/vercel.json"),
        "utf8",
      ),
    );

    expect(config).toEqual(juniorVercelConfig());
  });

  it("keeps the example queue trigger pointed at a concrete function source", () => {
    const config = juniorVercelConfig();
    const functionSources = Object.keys(config.functions as object);

    for (const source of functionSources) {
      expect(
        fs.existsSync(path.join(WORKSPACE_ROOT, "apps/example", source)),
      ).toBe(true);
    }
  });
});

describe("resolveConversationWorkVisibilityTimeoutSeconds", () => {
  it("keeps queue redelivery past the function timeout boundary", () => {
    expect(resolveConversationWorkVisibilityTimeoutSeconds(300)).toBe(330);
  });
});
