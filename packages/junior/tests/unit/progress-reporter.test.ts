import { describe, expect, it } from "vitest";
import { createAssistantStatusScheduler } from "@/chat/slack/assistant-thread/status-scheduler";
import { makeAssistantStatus } from "@/chat/slack/assistant-thread/status-render";

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

const firstGenericStatus = "Consulting the orb";
const secondSearchingStatus = "Searching sources";
const secondReadingStatus = "Reading source files";
const secondReviewingStatus = "Reviewing results";

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("createAssistantStatusScheduler", () => {
  it("posts the first generic loading message on start", async () => {
    const scheduler = createFakeScheduler();
    const statuses: string[] = [];
    const reporter = createAssistantStatusScheduler({
      sendStatus: async (text) => {
        statuses.push(text);
      },
      loadingMessages: ["Consulting the orb"],
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      random: () => 0,
    });

    reporter.start();
    await flushAsyncWork();

    expect(statuses).toEqual([firstGenericStatus]);
  });

  it("clears the assistant status when stopped", async () => {
    const scheduler = createFakeScheduler();
    const statuses: string[] = [];
    const reporter = createAssistantStatusScheduler({
      sendStatus: async (text) => {
        statuses.push(text);
      },
      loadingMessages: ["Consulting the orb"],
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      random: () => 0,
    });

    reporter.start();
    await flushAsyncWork();

    await reporter.stop();

    expect(statuses).toEqual([firstGenericStatus, ""]);
  });

  it("does not wait for the initial status request before start() returns", async () => {
    const scheduler = createFakeScheduler();
    let resolveThinking: (() => void) | undefined;
    const reporter = createAssistantStatusScheduler({
      sendStatus: async (text) => {
        if (text !== firstGenericStatus) {
          return;
        }
        await new Promise<void>((resolve) => {
          resolveThinking = resolve;
        });
      },
      loadingMessages: ["Consulting the orb"],
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
    const reporter = createAssistantStatusScheduler({
      sendStatus: async (text) => {
        if (text !== secondReviewingStatus) {
          return;
        }
        await new Promise<void>((resolve) => {
          resolveReviewing = resolve;
        });
      },
      loadingMessages: ["Consulting the orb"],
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

  it("omits loading messages when clearing the assistant status", async () => {
    const scheduler = createFakeScheduler();
    const calls: Array<{ text: string; loadingMessages?: string[] }> = [];
    const reporter = createAssistantStatusScheduler({
      sendStatus: async (text, loadingMessages) => {
        calls.push({ text, loadingMessages });
      },
      loadingMessages: ["Consulting the orb", "Bribing the gremlins"],
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
        text: expect.any(String),
        loadingMessages: expect.arrayContaining([
          "Consulting the orb",
          "Bribing the gremlins",
        ]),
      },
      { text: "", loadingMessages: undefined },
    ]);
  });

  it("suppresses duplicate pending statuses", async () => {
    const scheduler = createFakeScheduler();
    const statuses: string[] = [];
    const reporter = createAssistantStatusScheduler({
      sendStatus: async (text) => {
        statuses.push(text);
      },
      loadingMessages: ["Consulting the orb"],
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

    expect(statuses).toEqual([firstGenericStatus, secondSearchingStatus]);
  });

  it("enforces minimum visible duration before replacement", async () => {
    const scheduler = createFakeScheduler();
    const statuses: string[] = [];
    const reporter = createAssistantStatusScheduler({
      sendStatus: async (text) => {
        statuses.push(text);
      },
      loadingMessages: ["Consulting the orb"],
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
    expect(statuses).toEqual([firstGenericStatus]);

    scheduler.advance(200);
    await flushAsyncWork();
    expect(statuses).toEqual([firstGenericStatus, secondReadingStatus]);
  });

  it("keeps the latest status when multiple updates arrive before flush", async () => {
    const scheduler = createFakeScheduler();
    const statuses: string[] = [];
    const reporter = createAssistantStatusScheduler({
      sendStatus: async (text) => {
        statuses.push(text);
      },
      loadingMessages: ["Consulting the orb"],
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

    expect(statuses).toEqual([firstGenericStatus, secondReviewingStatus]);
  });

  it("serializes status updates so a slow request cannot reorder with the clear", async () => {
    const scheduler = createFakeScheduler();
    const statuses: string[] = [];
    let resolveThinking: (() => void) | undefined;
    const reporter = createAssistantStatusScheduler({
      sendStatus: async (text) => {
        if (text === firstGenericStatus) {
          await new Promise<void>((resolve) => {
            resolveThinking = resolve;
          });
        }
        statuses.push(text);
      },
      loadingMessages: ["Consulting the orb"],
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
    expect(statuses).toEqual([firstGenericStatus, ""]);
  });

  it("clears after the latest visible status when stopping", async () => {
    const scheduler = createFakeScheduler();
    const statuses: string[] = [];
    const reporter = createAssistantStatusScheduler({
      sendStatus: async (text) => {
        statuses.push(text);
      },
      loadingMessages: ["Consulting the orb"],
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

    expect(statuses).toEqual([firstGenericStatus, secondReviewingStatus, ""]);
  });

  it("refreshes the current status during long-running work", async () => {
    const scheduler = createFakeScheduler();
    const statuses: string[] = [];
    const reporter = createAssistantStatusScheduler({
      sendStatus: async (text) => {
        statuses.push(text);
      },
      loadingMessages: ["Consulting the orb"],
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      random: () => 0,
    });

    reporter.start();
    await flushAsyncWork();

    scheduler.advance(30_000);
    await flushAsyncWork();

    expect(statuses).toEqual([firstGenericStatus, firstGenericStatus]);
  });

  it("uses explicit progress text as the loading message", async () => {
    const scheduler = createFakeScheduler();
    const calls: Array<{ text: string; loadingMessages?: string[] }> = [];
    const reporter = createAssistantStatusScheduler({
      sendStatus: async (text, loadingMessages) => {
        calls.push({ text, loadingMessages });
      },
      loadingMessages: ["Consulting the orb"],
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      random: () => 0,
    });

    reporter.start();
    await flushAsyncWork();

    scheduler.advance(1200);
    reporter.update(makeAssistantStatus("reviewing", "results"));
    await flushAsyncWork();

    expect(calls).toEqual([
      {
        text: firstGenericStatus,
        loadingMessages: ["Consulting the orb"],
      },
      {
        text: secondReviewingStatus,
        loadingMessages: [secondReviewingStatus],
      },
    ]);
  });

  it("replaces generic loading messages when explicit progress matches the visible text", async () => {
    const scheduler = createFakeScheduler();
    const calls: Array<{ text: string; loadingMessages?: string[] }> = [];
    const reporter = createAssistantStatusScheduler({
      sendStatus: async (text, loadingMessages) => {
        calls.push({ text, loadingMessages });
      },
      loadingMessages: [secondReviewingStatus, "Consulting the orb"],
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      random: () => 0.9,
    });

    reporter.start();
    await flushAsyncWork();

    reporter.update(makeAssistantStatus("reviewing"));
    await flushAsyncWork();

    expect(calls).toEqual([
      {
        text: secondReviewingStatus,
        loadingMessages: [secondReviewingStatus, "Consulting the orb"],
      },
      {
        text: secondReviewingStatus,
        loadingMessages: [secondReviewingStatus],
      },
    ]);
  });
});
