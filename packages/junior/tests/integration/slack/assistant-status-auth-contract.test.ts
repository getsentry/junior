import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SlackAdapter } from "@chat-adapter/slack";
import {
  createSlackAdapterAssistantStatusSession,
  makeAssistantStatus,
} from "@/chat/slack/assistant-thread/status";
import { createJuniorSlackAdapter } from "@/chat/slack/adapter";
import {
  getCapturedSlackApiCalls,
  resetSlackApiMockState,
} from "../../msw/handlers/slack-api";

const SIGNING_SECRET = "test-signing-secret";
const DEFAULT_BOT_TOKEN = "xoxb-default";
const TEAM_BOT_TOKEN = "xoxb-team";
const BOT_USER_ID = "U_BOT";
const DM_CHANNEL_ID = "D12345";
const THREAD_TS = "1700000000.000001";

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

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function createAdapter(): SlackAdapter & {
  withBotToken<T>(token: string, fn: () => T): T;
} {
  return createJuniorSlackAdapter({
    botToken: DEFAULT_BOT_TOKEN,
    botUserId: BOT_USER_ID,
    signingSecret: SIGNING_SECRET,
  }) as SlackAdapter & {
    withBotToken<T>(token: string, fn: () => T): T;
  };
}

describe("Slack contract: assistant status auth", () => {
  beforeEach(() => {
    resetSlackApiMockState();
  });

  afterEach(() => {
    resetSlackApiMockState();
  });

  it("binds the active Slack token when creating the assistant status session", async () => {
    const adapter = createAdapter();
    const status = adapter.withBotToken(TEAM_BOT_TOKEN, () =>
      createSlackAdapterAssistantStatusSession({
        channelId: DM_CHANNEL_ID,
        threadTs: THREAD_TS,
        getSlackAdapter: () => adapter,
        random: () => 0,
      }),
    );

    status.start();
    await flushAsyncWork();

    expect(getCapturedSlackApiCalls("assistant.threads.setStatus")).toEqual([
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: `Bearer ${TEAM_BOT_TOKEN}`,
        }),
        params: expect.objectContaining({
          channel_id: DM_CHANNEL_ID,
          thread_ts: THREAD_TS,
          status: "Thinking …",
        }),
      }),
    ]);
  });

  it("reuses the bound Slack token for delayed progress updates", async () => {
    const adapter = createAdapter();
    const scheduler = createFakeScheduler();
    const reporter = adapter.withBotToken(TEAM_BOT_TOKEN, () =>
      createSlackAdapterAssistantStatusSession({
        channelId: DM_CHANNEL_ID,
        threadTs: THREAD_TS,
        getSlackAdapter: () => adapter,
        now: scheduler.now,
        setTimer: scheduler.setTimer,
        clearTimer: scheduler.clearTimer,
        random: () => 0,
      }),
    );

    reporter.start();
    await flushAsyncWork();
    reporter.update(makeAssistantStatus("searching", "sources"));

    scheduler.advance(1200);
    await flushAsyncWork();

    expect(getCapturedSlackApiCalls("assistant.threads.setStatus")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          headers: expect.objectContaining({
            authorization: `Bearer ${TEAM_BOT_TOKEN}`,
          }),
          params: expect.objectContaining({
            channel_id: DM_CHANNEL_ID,
            thread_ts: THREAD_TS,
            status: "Thinking …",
          }),
        }),
        expect.objectContaining({
          headers: expect.objectContaining({
            authorization: `Bearer ${TEAM_BOT_TOKEN}`,
          }),
          params: expect.objectContaining({
            channel_id: DM_CHANNEL_ID,
            thread_ts: THREAD_TS,
            status: "Searching sources",
          }),
        }),
      ]),
    );
  });
});
