import { describe, expect, it } from "vitest";
import { readChatConfig } from "@/chat/config";

const BASE_ENV = {
  DATABASE_URL: "postgres://localhost/junior",
  JUNIOR_STATE_ADAPTER: "memory",
};

describe("execution budget decision matrix", () => {
  it.each([
    {
      label: "uses the safe default budget",
      maxDuration: undefined,
      turnTimeout: undefined,
      expectedTurnTimeoutMs: 280_000,
      expectedSoftYieldMs: 260_000,
    },
    {
      label: "derives budgets from maxDuration",
      maxDuration: 800,
      turnTimeout: undefined,
      expectedTurnTimeoutMs: 720_000,
      expectedSoftYieldMs: 760_000,
    },
    {
      label: "allows a shorter agent timeout",
      maxDuration: 800,
      turnTimeout: "240000",
      expectedTurnTimeoutMs: 240_000,
      expectedSoftYieldMs: 760_000,
    },
    {
      label: "caps an agent timeout below the host budget",
      maxDuration: 500,
      turnTimeout: "999999",
      expectedTurnTimeoutMs: 480_000,
      expectedSoftYieldMs: 460_000,
    },
  ])(
    "$label",
    ({
      maxDuration,
      turnTimeout,
      expectedTurnTimeoutMs,
      expectedSoftYieldMs,
    }) => {
      const env = {
        ...BASE_ENV,
        ...(turnTimeout === undefined
          ? undefined
          : { AGENT_TURN_TIMEOUT_MS: turnTimeout }),
        // These legacy values must not affect the generated host budget.
        FUNCTION_MAX_DURATION_SECONDS: "900",
        QUEUE_CALLBACK_MAX_DURATION_SECONDS: "900",
      };
      const config = readChatConfig(env, maxDuration);

      expect(config.functionMaxDurationSeconds).toBe(maxDuration ?? 300);
      expect(config.bot.turnTimeoutMs).toBe(expectedTurnTimeoutMs);
      expect(config.conversationWorkSoftYieldAfterMs).toBe(expectedSoftYieldMs);
    },
  );
});
