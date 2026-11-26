import { describe, expect, it } from "vitest";
import { hasLongSleep } from "@/chat/tool-support/sandbox/long-sleep";

describe("hasLongSleep", () => {
  it.each([
    "sleep 240; gh pr checks 4435 | grep fail",
    "cd repo && sleep 90 && curl -s localhost:3000",
    "nohup pnpm test > log 2>&1 &\nsleep 230; grep -c ok log",
    "while true; do sleep 60; gh run view 1; done",
    "sleep 1m",
    "sleep 20 15",
    "sleep infinity",
  ])("rejects %j", (command) => {
    expect(hasLongSleep(command)).toBe(true);
  });

  it.each([
    "sleep 30",
    "sleep 0.5 && curl -s localhost:3000",
    "timeout 300 bash -c 'until curl -sf localhost:3000; do sleep 2; done'",
    "wait $PID",
    "python -c 'import time; time.sleep(240)'",
    "playwright test --sleep 240",
    "grep -rn sleep src",
  ])("allows %j", (command) => {
    expect(hasLongSleep(command)).toBe(false);
  });
});
