import { describe, expect, it } from "vitest";
import { createProgressReporter } from "@/chat/progress-reporter";

interface FakeTimer {
  id: number;
  runAt: number;
  callback: () => void;
  canceled: boolean;
}

function createFakeScheduler() {
  let nowMs = 0;
  let nextId = 1;
  const timers: FakeTimer[] = [];

  const now = () => nowMs;

  const setTimer = (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
    const timer: FakeTimer = {
      id: nextId++,
      runAt: nowMs + delayMs,
      callback,
      canceled: false
    };
    timers.push(timer);
    return timer.id as unknown as ReturnType<typeof setTimeout>;
  };

  const clearTimer = (timer: ReturnType<typeof setTimeout>) => {
    const id = timer as unknown as number;
    const entry = timers.find((candidate) => candidate.id === id);
    if (entry) {
      entry.canceled = true;
    }
  };

  const advance = (ms: number) => {
    nowMs += ms;
    let ran = true;
    while (ran) {
      ran = false;
      for (const timer of timers) {
        if (!timer.canceled && timer.runAt <= nowMs) {
          timer.canceled = true;
          timer.callback();
          ran = true;
        }
      }
    }
  };

  return {
    now,
    setTimer,
    clearTimer,
    advance
  };
}

describe("createProgressReporter", () => {
  it("posts initial Thinking status on start", async () => {
    const scheduler = createFakeScheduler();
    const statuses: string[] = [];
    const reporter = createProgressReporter({
      channelId: "C1",
      threadTs: "123.45",
      setAssistantStatus: async (_channelId, _threadTs, text) => {
        statuses.push(text);
      },
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer
    });

    await reporter.start();
    await Promise.resolve();

    expect(statuses).toEqual(["Thinking..."]);
  });

  it("suppresses duplicate pending statuses", async () => {
    const scheduler = createFakeScheduler();
    const statuses: string[] = [];
    const reporter = createProgressReporter({
      channelId: "C1",
      threadTs: "123.45",
      setAssistantStatus: async (_channelId, _threadTs, text) => {
        statuses.push(text);
      },
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer
    });

    await reporter.start();
    await Promise.resolve();

    await reporter.setStatus("Searching");
    await reporter.setStatus("Searching");
    scheduler.advance(1200);
    await Promise.resolve();

    expect(statuses).toEqual(["Thinking...", "Searching"]);
  });

  it("enforces minimum visible duration before replacement", async () => {
    const scheduler = createFakeScheduler();
    const statuses: string[] = [];
    const reporter = createProgressReporter({
      channelId: "C1",
      threadTs: "123.45",
      setAssistantStatus: async (_channelId, _threadTs, text) => {
        statuses.push(text);
      },
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer
    });

    await reporter.start();
    await Promise.resolve();

    await reporter.setStatus("Reading source files");
    scheduler.advance(1000);
    await Promise.resolve();
    expect(statuses).toEqual(["Thinking..."]);

    scheduler.advance(200);
    await Promise.resolve();
    expect(statuses).toEqual(["Thinking...", "Reading source files"]);
  });

  it("keeps the latest status when multiple updates arrive before flush", async () => {
    const scheduler = createFakeScheduler();
    const statuses: string[] = [];
    const reporter = createProgressReporter({
      channelId: "C1",
      threadTs: "123.45",
      setAssistantStatus: async (_channelId, _threadTs, text) => {
        statuses.push(text);
      },
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer
    });

    await reporter.start();
    await Promise.resolve();

    await reporter.setStatus("Searching docs");
    await reporter.setStatus("Reviewing results");

    scheduler.advance(1200);
    await Promise.resolve();

    expect(statuses).toEqual(["Thinking...", "Reviewing results"]);
  });
});
