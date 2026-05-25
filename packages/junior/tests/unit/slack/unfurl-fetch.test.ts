import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks must be declared before importing the module under test ──────

vi.mock("@/chat/slack/channel", () => ({
  listThreadReplies: vi.fn(),
}));

// Use fake timers so sleep() resolves instantly.
// Must be set up before the module under test resolves its timer calls.

import { listThreadReplies } from "@/chat/slack/channel";
import { maybeRefetchSlackUnfurlAttachments } from "@/chat/slack/unfurl-fetch";

const mockListThreadReplies = vi.mocked(listThreadReplies);

const CHANNEL = "C_TEST";
const THREAD_TS = "1700000000.000001";
const MESSAGE_TS = "1700000000.000001";

const UNFURL_ATTACHMENT = [
  {
    title: "Discord – Some Channel",
    title_link: "https://discord.com/channels/123/456/789",
    text: "sentry-self-hosted-generic-metrics-consumer-1 is unhealthy upon start",
    footer: "Discord",
  },
];

function baseInput(overrides?: {
  channelId?: string | undefined;
  threadTs?: string | undefined;
  messageTs?: string | undefined;
  originalRaw?: unknown;
  text?: string | undefined;
}) {
  return {
    channelId: CHANNEL,
    threadTs: THREAD_TS,
    messageTs: MESSAGE_TS,
    originalRaw: { channel: CHANNEL, ts: MESSAGE_TS, attachments: [] },
    text: "check https://discord.com/channels/123/456/789",
    ...overrides,
  };
}

describe("maybeRefetchSlackUnfurlAttachments", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it("returns originalRaw unchanged when raw already has attachments", async () => {
    const rawWithAttachments = {
      channel: CHANNEL,
      ts: MESSAGE_TS,
      attachments: UNFURL_ATTACHMENT,
    };

    const promise = maybeRefetchSlackUnfurlAttachments(
      baseInput({ originalRaw: rawWithAttachments }),
    );
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe(rawWithAttachments);
    expect(mockListThreadReplies).not.toHaveBeenCalled();
  });

  it("returns originalRaw unchanged when text has no URLs", async () => {
    const promise = maybeRefetchSlackUnfurlAttachments(
      baseInput({ text: "just a plain message, no links" }),
    );
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual(baseInput().originalRaw);
    expect(mockListThreadReplies).not.toHaveBeenCalled();
  });

  it("returns originalRaw unchanged when channelId is undefined", async () => {
    const promise = maybeRefetchSlackUnfurlAttachments(
      baseInput({ channelId: undefined }),
    );
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual(baseInput().originalRaw);
    expect(mockListThreadReplies).not.toHaveBeenCalled();
  });

  it("returns originalRaw unchanged when messageTs is undefined", async () => {
    const promise = maybeRefetchSlackUnfurlAttachments(
      baseInput({ messageTs: undefined }),
    );
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual(baseInput().originalRaw);
    expect(mockListThreadReplies).not.toHaveBeenCalled();
  });

  it("returns enriched raw when Slack returns attachments on first retry", async () => {
    mockListThreadReplies.mockResolvedValueOnce([
      { ts: MESSAGE_TS, attachments: UNFURL_ATTACHMENT },
    ]);

    const promise = maybeRefetchSlackUnfurlAttachments(baseInput());
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toMatchObject({ attachments: UNFURL_ATTACHMENT });
    expect(mockListThreadReplies).toHaveBeenCalledOnce();
    expect(mockListThreadReplies).toHaveBeenCalledWith({
      channelId: CHANNEL,
      threadTs: THREAD_TS,
      targetMessageTs: [MESSAGE_TS],
      limit: 1,
      maxPages: 1,
    });
  });

  it("retries when first call returns no attachments and second succeeds", async () => {
    mockListThreadReplies
      .mockResolvedValueOnce([{ ts: MESSAGE_TS, attachments: [] }])
      .mockResolvedValueOnce([
        { ts: MESSAGE_TS, attachments: UNFURL_ATTACHMENT },
      ]);

    const promise = maybeRefetchSlackUnfurlAttachments(baseInput());
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toMatchObject({ attachments: UNFURL_ATTACHMENT });
    expect(mockListThreadReplies).toHaveBeenCalledTimes(2);
  });

  it("returns originalRaw gracefully when all retries find no attachments", async () => {
    mockListThreadReplies.mockResolvedValue([
      { ts: MESSAGE_TS, attachments: [] },
    ]);

    const promise = maybeRefetchSlackUnfurlAttachments(baseInput());
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual(baseInput().originalRaw);
    expect(mockListThreadReplies).toHaveBeenCalledTimes(3);
  });

  it("returns originalRaw gracefully when listThreadReplies throws", async () => {
    mockListThreadReplies.mockRejectedValueOnce(new Error("network error"));

    const promise = maybeRefetchSlackUnfurlAttachments(baseInput());
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual(baseInput().originalRaw);
  });

  it("uses messageTs as threadTs fallback when threadTs is undefined", async () => {
    mockListThreadReplies.mockResolvedValueOnce([
      { ts: MESSAGE_TS, attachments: UNFURL_ATTACHMENT },
    ]);

    const promise = maybeRefetchSlackUnfurlAttachments(
      baseInput({ threadTs: undefined }),
    );
    await vi.runAllTimersAsync();
    await promise;

    expect(mockListThreadReplies).toHaveBeenCalledWith(
      expect.objectContaining({ threadTs: MESSAGE_TS }),
    );
  });

  it("preserves existing raw fields on the returned enriched object", async () => {
    const rawWithMeta = {
      channel: CHANNEL,
      ts: MESSAGE_TS,
      user: "U_SERGIY",
      attachments: [],
    };
    mockListThreadReplies.mockResolvedValueOnce([
      { ts: MESSAGE_TS, attachments: UNFURL_ATTACHMENT },
    ]);

    const promise = maybeRefetchSlackUnfurlAttachments(
      baseInput({ originalRaw: rawWithMeta }),
    );
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toMatchObject({
      channel: CHANNEL,
      ts: MESSAGE_TS,
      user: "U_SERGIY",
      attachments: UNFURL_ATTACHMENT,
    });
  });
});
