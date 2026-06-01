import { describe, expect, it } from "vitest";
import { DEFAULT_CONVERSATION_WORK_QUEUE_TOPIC } from "@/chat/task-execution/vercel-queue";
import { juniorVercelConfig } from "@/vercel";

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
      "server.ts": {
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
});
