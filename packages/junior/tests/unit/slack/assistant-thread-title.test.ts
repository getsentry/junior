import { describe, expect, it, vi } from "vitest";
import { maybeSyncAssistantTitle } from "@/chat/slack/assistant-thread/title";

const DM_CHANNEL_ID = "D12345";
const CHANNEL_ID = "C12345";
const THREAD_TS = "1700000000.000001";
const GENERATED_TITLE = "Debugging Node.js Memory Leaks";

function makeArgs(
  channelId: string,
  overrides?: {
    setAssistantTitle?: (...args: unknown[]) => Promise<void>;
    threadTs?: string;
    title?: string;
  },
) {
  const setAssistantTitle =
    overrides?.setAssistantTitle ?? vi.fn().mockResolvedValue(undefined);

  return {
    channelId,
    getSlackAdapter: () => ({ setAssistantTitle }),
    threadTs: overrides?.threadTs ?? THREAD_TS,
    title: overrides?.title ?? GENERATED_TITLE,
    _setAssistantTitle: setAssistantTitle,
  };
}

describe("maybeSyncAssistantTitle", () => {
  it("calls setAssistantTitle for a DM thread", async () => {
    const args = makeArgs(DM_CHANNEL_ID);
    await maybeSyncAssistantTitle(args);

    expect(args._setAssistantTitle).toHaveBeenCalledWith(
      DM_CHANNEL_ID,
      THREAD_TS,
      GENERATED_TITLE,
    );
  });

  it("does not call setAssistantTitle for a public channel", async () => {
    const args = makeArgs(CHANNEL_ID);
    await maybeSyncAssistantTitle(args);

    expect(args._setAssistantTitle).not.toHaveBeenCalled();
  });

  it("swallows permission errors from setAssistantTitle", async () => {
    const permissionError = { data: { error: "no_permission" } };
    const args = makeArgs(DM_CHANNEL_ID, {
      setAssistantTitle: vi.fn().mockRejectedValue(permissionError),
    });

    await expect(maybeSyncAssistantTitle(args)).resolves.toBeUndefined();
  });

  it("swallows non-permission errors from setAssistantTitle", async () => {
    const args = makeArgs(DM_CHANNEL_ID, {
      setAssistantTitle: vi.fn().mockRejectedValue(new Error("network fail")),
    });

    await expect(maybeSyncAssistantTitle(args)).resolves.toBeUndefined();
  });

  it("returns early when channel or thread identifiers are missing", async () => {
    const args = makeArgs(DM_CHANNEL_ID, { threadTs: undefined });
    await maybeSyncAssistantTitle({
      ...args,
      threadTs: undefined,
    });
    expect(args._setAssistantTitle).not.toHaveBeenCalled();
  });
});
