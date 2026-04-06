import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

function setOrDelete(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

describe("turnTimeoutMs decision matrix", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  it.each([
    {
      label: "all defaults",
      turnMs: undefined,
      funcMax: undefined,
      queueMax: undefined,
      expected: 720000,
    },
    {
      label: "explicit turn timeout",
      turnMs: "600000",
      funcMax: undefined,
      queueMax: undefined,
      expected: 600000,
    },
    {
      label: "invalid turn timeout falls back to default",
      turnMs: "not-a-number",
      funcMax: undefined,
      queueMax: undefined,
      expected: 720000,
    },
    {
      label:
        "turn timeout capped by default function max (800s - 20s buffer = 780s)",
      turnMs: "999999",
      funcMax: undefined,
      queueMax: undefined,
      expected: 780000,
    },
    {
      label: "turn timeout capped by FUNCTION_MAX_DURATION_SECONDS",
      turnMs: "999999",
      funcMax: "500",
      queueMax: undefined,
      expected: 480000,
    },
    {
      label: "QUEUE_CALLBACK_MAX_DURATION_SECONDS as fallback",
      turnMs: "999999",
      funcMax: undefined,
      queueMax: "500",
      expected: 480000,
    },
    {
      label: "turn timeout floored at minimum (10s)",
      turnMs: "5000",
      funcMax: undefined,
      queueMax: undefined,
      expected: 10000,
    },
    {
      label:
        "FUNCTION_MAX_DURATION_SECONDS takes precedence over QUEUE_CALLBACK",
      turnMs: "999999",
      funcMax: "500",
      queueMax: "600",
      expected: 480000,
    },
  ])("$label", async ({ turnMs, funcMax, queueMax, expected }) => {
    setOrDelete("AGENT_TURN_TIMEOUT_MS", turnMs);
    setOrDelete("FUNCTION_MAX_DURATION_SECONDS", funcMax);
    setOrDelete("QUEUE_CALLBACK_MAX_DURATION_SECONDS", queueMax);
    vi.resetModules();
    const { readChatConfig } = await import("@/chat/config");
    expect(readChatConfig(process.env).bot.turnTimeoutMs).toBe(expected);
  });
});
