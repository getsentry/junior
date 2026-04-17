import { describe, expect, it } from "vitest";
import {
  createSlackAssistantStatusSession,
  makeAssistantStatus,
} from "@/chat/slack/assistant-thread/status";

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

const firstPlayfulStatus = "Thinking …";
const secondSearchingStatus = "Searching sources";
const secondReadingStatus = "Reading source files";
const secondReviewingStatus = "Reviewing results";

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("createSlackAssistantStatusSession", () => {
  it("posts an initial playful status on start", async () => {
    const scheduler = createFakeScheduler();
    const statuses: string[] = [];
    const reporter = createSlackAssistantStatusSession({
      channelId: "C1",
      threadTs: "123.45",
      setStatus: async (_channelId, _threadTs, text) => {
        statuses.push(text);
      },
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      random: () => 0,
    });

    reporter.start();
    await flushAsyncWork();

    expect(statuses).toEqual([firstPlayfulStatus]);
  });

  it("clears the assistant status when stopped", async () => {
    const scheduler = createFakeScheduler();
    const statuses: string[] = [];
    const reporter = createSlackAssistantStatusSession({
      channelId: "C1",
      threadTs: "123.45",
      setStatus: async (_channelId, _threadTs, text) => {
        statuses.push(text);
      },
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      random: () => 0,
    });

    reporter.start();
    await flushAsyncWork();

    await reporter.stop();

    expect(statuses).toEqual([firstPlayfulStatus, ""]);
  });

  it("does not wait for the initial status request before start() returns", async () => {
    const scheduler = createFakeScheduler();
    let resolveThinking: (() => void) | undefined;
    const reporter = createSlackAssistantStatusSession({
      channelId: "C1",
      threadTs: "123.45",
      setStatus: async (_channelId, _threadTs, text) => {
        if (text !== firstPlayfulStatus) {
          return;
        }
        await new Promise<void>((resolve) => {
          resolveThinking = resolve;
        });
      },
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      random: () => 0,
    });

    const result = reporter.start();
    expect(result).toBeUndefined();
    await flushAsyncWork();

    resolveThinking!();
    await flushAsyncWork();
  });

  it("does not wait for an immediate replacement status before update() returns", async () => {
    const scheduler = createFakeScheduler();
    let resolveReviewing: (() => void) | undefined;
    const reporter = createSlackAssistantStatusSession({
      channelId: "C1",
      threadTs: "123.45",
      setStatus: async (_channelId, _threadTs, text) => {
        if (text !== secondReviewingStatus) {
          return;
        }
        await new Promise<void>((resolve) => {
          resolveReviewing = resolve;
        });
      },
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      random: () => 0,
    });

    reporter.start();
    await flushAsyncWork();

    scheduler.advance(1200);
    const result = reporter.update(makeAssistantStatus("reviewing"));
    expect(result).toBeUndefined();
    await flushAsyncWork();

    resolveReviewing!();
    await flushAsyncWork();
  });

  it("omits loading suggestions when clearing the assistant status", async () => {
    const scheduler = createFakeScheduler();
    const calls: Array<{ text: string; suggestions?: string[] }> = [];
    const reporter = createSlackAssistantStatusSession({
      channelId: "C1",
      threadTs: "123.45",
      setStatus: async (_channelId, _threadTs, text, suggestions) => {
        calls.push({ text, suggestions });
      },
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      random: () => 0,
    });

    reporter.start();
    await flushAsyncWork();

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
    const reporter = createSlackAssistantStatusSession({
      channelId: "C1",
      threadTs: "123.45",
      setStatus: async (_channelId, _threadTs, text) => {
        statuses.push(text);
      },
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      random: () => 0,
    });

    reporter.start();
    await flushAsyncWork();

    reporter.update(makeAssistantStatus("searching"));
    reporter.update(makeAssistantStatus("searching"));
    scheduler.advance(1200);
    await flushAsyncWork();

    expect(statuses).toEqual([firstPlayfulStatus, secondSearchingStatus]);
  });

  it("enforces minimum visible duration before replacement", async () => {
    const scheduler = createFakeScheduler();
    const statuses: string[] = [];
    const reporter = createSlackAssistantStatusSession({
      channelId: "C1",
      threadTs: "123.45",
      setStatus: async (_channelId, _threadTs, text) => {
        statuses.push(text);
      },
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      random: () => 0,
    });

    reporter.start();
    await flushAsyncWork();

    reporter.update(makeAssistantStatus("reading", "source files"));
    scheduler.advance(1000);
    await flushAsyncWork();
    expect(statuses).toEqual([firstPlayfulStatus]);

    scheduler.advance(200);
    await flushAsyncWork();
    expect(statuses).toEqual([firstPlayfulStatus, secondReadingStatus]);
  });

  it("keeps the latest status when multiple updates arrive before flush", async () => {
    const scheduler = createFakeScheduler();
    const statuses: string[] = [];
    const reporter = createSlackAssistantStatusSession({
      channelId: "C1",
      threadTs: "123.45",
      setStatus: async (_channelId, _threadTs, text) => {
        statuses.push(text);
      },
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      random: () => 0,
    });

    reporter.start();
    await flushAsyncWork();

    reporter.update(makeAssistantStatus("searching", "docs"));
    reporter.update(makeAssistantStatus("reviewing"));

    scheduler.advance(1200);
    await flushAsyncWork();

    expect(statuses).toEqual([firstPlayfulStatus, secondReviewingStatus]);
  });

  it("serializes status updates so a slow request cannot reorder with the clear", async () => {
    const scheduler = createFakeScheduler();
    const statuses: string[] = [];
    let resolveThinking: (() => void) | undefined;
    const reporter = createSlackAssistantStatusSession({
      channelId: "C1",
      threadTs: "123.45",
      setStatus: async (_channelId, _threadTs, text) => {
        if (text === firstPlayfulStatus) {
          await new Promise<void>((resolve) => {
            resolveThinking = resolve;
          });
        }
        statuses.push(text);
      },
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      random: () => 0,
    });

    reporter.start();
    await flushAsyncWork();
    // Initial playful status is now in flight but blocked

    const endPromise = reporter.stop();
    // stop() should wait for the inflight status before sending ""

    // Unblock the slow initial status call
    resolveThinking!();
    await endPromise;

    // The clear must always be the last status sent to Slack
    expect(statuses).toEqual([firstPlayfulStatus, ""]);
  });

  it("clears after the latest visible status when stopping", async () => {
    const scheduler = createFakeScheduler();
    const statuses: string[] = [];
    const reporter = createSlackAssistantStatusSession({
      channelId: "C1",
      threadTs: "123.45",
      setStatus: async (_channelId, _threadTs, text) => {
        statuses.push(text);
      },
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      random: () => 0,
    });

    reporter.start();
    await flushAsyncWork();

    reporter.update(makeAssistantStatus("reviewing"));
    scheduler.advance(1200);
    await flushAsyncWork();

    await reporter.stop();

    expect(statuses).toEqual([firstPlayfulStatus, secondReviewingStatus, ""]);
  });

  it("refreshes the current status during long-running work", async () => {
    const scheduler = createFakeScheduler();
    const statuses: string[] = [];
    const reporter = createSlackAssistantStatusSession({
      channelId: "C1",
      threadTs: "123.45",
      setStatus: async (_channelId, _threadTs, text) => {
        statuses.push(text);
      },
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      random: () => 0,
    });

    reporter.start();
    await flushAsyncWork();

    scheduler.advance(30_000);
    await flushAsyncWork();

    expect(statuses).toEqual([firstPlayfulStatus, firstPlayfulStatus]);
  });
});
