import { describe, expect, it } from "vitest";
import { makeAssistantStatus } from "@/chat/runtime/assistant-status";
import { createProgressReporter } from "@/chat/runtime/progress-reporter";

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

  const setTimer = (
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout> => {
    const timer: FakeTimer = {
      id: nextId++,
      runAt: nowMs + delayMs,
      callback,
      canceled: false,
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
    advance,
  };
}

const firstPlayfulStatus = "Thinking task";
const secondPlayfulStatus = "Reasoning task";
const secondSearchingStatus = "Searching sources";
const secondReadingStatus = "Reading source files";
const secondReviewingStatus = "Reviewing results";

describe("createProgressReporter", () => {
  it("posts an initial playful status on start", async () => {
    const scheduler = createFakeScheduler();
    const statuses: string[] = [];
    const reporter = createProgressReporter({
      channelId: "C1",
      threadTs: "123.45",
      transport: {
        setStatus: async (_channelId, _threadTs, text) => {
          statuses.push(text);
        },
      },
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      random: () => 0,
    });

    await reporter.start();
    await Promise.resolve();

    expect(statuses).toEqual([firstPlayfulStatus]);
  });

  it("clears the assistant status when stopped", async () => {
    const scheduler = createFakeScheduler();
    const statuses: string[] = [];
    const reporter = createProgressReporter({
      channelId: "C1",
      threadTs: "123.45",
      transport: {
        setStatus: async (_channelId, _threadTs, text) => {
          statuses.push(text);
        },
      },
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      random: () => 0,
    });

    await reporter.start();
    await Promise.resolve();

    await reporter.stop();

    expect(statuses).toEqual([firstPlayfulStatus, ""]);
  });

  it("omits loading suggestions when clearing the assistant status", async () => {
    const scheduler = createFakeScheduler();
    const calls: Array<{ text: string; suggestions?: string[] }> = [];
    const reporter = createProgressReporter({
      channelId: "C1",
      threadTs: "123.45",
      transport: {
        setStatus: async (_channelId, _threadTs, text, suggestions) => {
          calls.push({ text, suggestions });
        },
      },
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      random: () => 0,
    });

    await reporter.start();
    await Promise.resolve();

    await reporter.stop();

    expect(calls).toEqual([
      {
        text: firstPlayfulStatus,
        suggestions: [firstPlayfulStatus],
      },
      { text: "", suggestions: undefined },
    ]);
  });

  it("suppresses duplicate pending statuses", async () => {
    const scheduler = createFakeScheduler();
    const statuses: string[] = [];
    const reporter = createProgressReporter({
      channelId: "C1",
      threadTs: "123.45",
      transport: {
        setStatus: async (_channelId, _threadTs, text) => {
          statuses.push(text);
        },
      },
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      random: () => 0,
    });

    await reporter.start();
    await Promise.resolve();

    await reporter.setStatus(makeAssistantStatus("searching"));
    await reporter.setStatus(makeAssistantStatus("searching"));
    scheduler.advance(1200);
    await Promise.resolve();

    expect(statuses).toEqual([firstPlayfulStatus, secondSearchingStatus]);
  });

  it("enforces minimum visible duration before replacement", async () => {
    const scheduler = createFakeScheduler();
    const statuses: string[] = [];
    const reporter = createProgressReporter({
      channelId: "C1",
      threadTs: "123.45",
      transport: {
        setStatus: async (_channelId, _threadTs, text) => {
          statuses.push(text);
        },
      },
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      random: () => 0,
    });

    await reporter.start();
    await Promise.resolve();

    await reporter.setStatus(makeAssistantStatus("reading", "source files"));
    scheduler.advance(1000);
    await Promise.resolve();
    expect(statuses).toEqual([firstPlayfulStatus]);

    scheduler.advance(200);
    await Promise.resolve();
    expect(statuses).toEqual([firstPlayfulStatus, secondReadingStatus]);
  });

  it("keeps the latest status when multiple updates arrive before flush", async () => {
    const scheduler = createFakeScheduler();
    const statuses: string[] = [];
    const reporter = createProgressReporter({
      channelId: "C1",
      threadTs: "123.45",
      transport: {
        setStatus: async (_channelId, _threadTs, text) => {
          statuses.push(text);
        },
      },
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      random: () => 0,
    });

    await reporter.start();
    await Promise.resolve();

    await reporter.setStatus(makeAssistantStatus("searching", "docs"));
    await reporter.setStatus(makeAssistantStatus("reviewing"));

    scheduler.advance(1200);
    await Promise.resolve();

    expect(statuses).toEqual([firstPlayfulStatus, secondReviewingStatus]);
  });

  it("serializes status updates so a slow request cannot reorder with the clear", async () => {
    const scheduler = createFakeScheduler();
    const statuses: string[] = [];
    let resolveThinking: (() => void) | undefined;
    const reporter = createProgressReporter({
      channelId: "C1",
      threadTs: "123.45",
      transport: {
        setStatus: async (_channelId, _threadTs, text) => {
          if (text === firstPlayfulStatus) {
            await new Promise<void>((resolve) => {
              resolveThinking = resolve;
            });
          }
          statuses.push(text);
        },
      },
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      random: () => 0,
    });

    await reporter.start();
    // Initial playful status is now in flight but blocked

    const stopPromise = reporter.stop();
    // stop() should wait for the inflight status before sending ""

    // Unblock the slow initial status call
    resolveThinking!();
    await stopPromise;

    // The clear must always be the last status sent to Slack
    expect(statuses).toEqual([firstPlayfulStatus, ""]);
  });

  it("clears after the latest visible status when stopping", async () => {
    const scheduler = createFakeScheduler();
    const statuses: string[] = [];
    const reporter = createProgressReporter({
      channelId: "C1",
      threadTs: "123.45",
      transport: {
        setStatus: async (_channelId, _threadTs, text) => {
          statuses.push(text);
        },
      },
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      random: () => 0,
    });

    await reporter.start();
    await Promise.resolve();

    await reporter.setStatus(makeAssistantStatus("reviewing"));
    scheduler.advance(1200);
    await Promise.resolve();

    await reporter.stop();

    expect(statuses).toEqual([firstPlayfulStatus, secondReviewingStatus, ""]);
  });

  it("refreshes the current status during long-running work", async () => {
    const scheduler = createFakeScheduler();
    const statuses: string[] = [];
    const reporter = createProgressReporter({
      channelId: "C1",
      threadTs: "123.45",
      transport: {
        setStatus: async (_channelId, _threadTs, text) => {
          statuses.push(text);
        },
      },
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      random: () => 0,
    });

    await reporter.start();
    await Promise.resolve();

    scheduler.advance(30_000);
    await Promise.resolve();

    expect(statuses).toEqual([firstPlayfulStatus, firstPlayfulStatus]);
  });
});
