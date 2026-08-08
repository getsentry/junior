import type { Thread } from "chat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getChannelConfigurationService,
  getPersistedChannelState,
  getPersistedSandboxState,
  getPersistedThreadState,
  persistThreadRuntimeState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { JUNIOR_THREAD_STATE_TTL_MS } from "@/chat/state/ttl";

const originalStateAdapter = process.env.JUNIOR_STATE_ADAPTER;

describe("thread sandbox state", () => {
  beforeEach(async () => {
    process.env.JUNIOR_STATE_ADAPTER = "memory";
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
    if (originalStateAdapter === undefined) {
      delete process.env.JUNIOR_STATE_ADAPTER;
    } else {
      process.env.JUNIOR_STATE_ADAPTER = originalStateAdapter;
    }
  });

  it("clears a stale profile hash when the replacement reference omits one", async () => {
    const conversationId = "local:test:thread-sandbox-state";
    await persistThreadStateById(conversationId, {
      sandboxRef: { id: "sandbox-old", profileHash: "profile-old" },
    });

    await persistThreadStateById(conversationId, {
      sandboxRef: { id: "sandbox-new" },
    });

    const state = await getPersistedThreadState(conversationId);
    expect(state).toMatchObject({
      app_sandbox_id: "sandbox-new",
      app_sandbox_dependency_profile_hash: "",
    });
    expect(getPersistedSandboxState(state)).toEqual({ id: "sandbox-new" });
  });

  it("clears both fields when the sandbox reference is removed", async () => {
    const conversationId = "local:test:thread-sandbox-clear";
    await persistThreadStateById(conversationId, {
      sandboxRef: { id: "sandbox-old", profileHash: "profile-old" },
    });

    await persistThreadStateById(conversationId, { sandboxRef: null });

    const state = await getPersistedThreadState(conversationId);
    expect(state).toMatchObject({
      app_sandbox_id: "",
      app_sandbox_dependency_profile_hash: "",
    });
    expect(getPersistedSandboxState(state)).toBeUndefined();
  });

  it("writes thread and channel scratch with Junior's 7-day TTL", async () => {
    const stateAdapter = getStateAdapter();
    const set = vi.spyOn(stateAdapter, "set");
    const conversationId = "local:test:thread-scratch-ttl";
    const channelId = "C-scratch-ttl";

    await persistThreadStateById(conversationId, {
      sandboxRef: { id: "sandbox-ttl" },
    });
    expect(set).toHaveBeenCalledWith(
      `thread-state:${conversationId}`,
      expect.objectContaining({ app_sandbox_id: "sandbox-ttl" }),
      JUNIOR_THREAD_STATE_TTL_MS,
    );

    set.mockClear();
    const thread = {
      id: conversationId,
      channelId,
      channel: { id: channelId },
    } as Thread;
    await persistThreadRuntimeState(thread, {
      artifacts: { lastCanvasId: "Fcanvas" },
    });
    expect(set).toHaveBeenCalledWith(
      `thread-state:${conversationId}`,
      expect.objectContaining({
        app_sandbox_id: "sandbox-ttl",
        artifacts: expect.objectContaining({ lastCanvasId: "Fcanvas" }),
      }),
      JUNIOR_THREAD_STATE_TTL_MS,
    );

    set.mockClear();
    await getChannelConfigurationService(thread).set({
      key: "github.repo",
      value: "getsentry/junior",
      updatedBy: "U123",
    });
    expect(set).toHaveBeenCalledWith(
      `channel-state:${channelId}`,
      expect.objectContaining({
        configuration: expect.objectContaining({
          entries: expect.objectContaining({
            "github.repo": expect.objectContaining({
              key: "github.repo",
              value: "getsentry/junior",
            }),
          }),
        }),
      }),
      JUNIOR_THREAD_STATE_TTL_MS,
    );

    await expect(getPersistedChannelState(channelId)).resolves.toMatchObject({
      configuration: {
        entries: {
          "github.repo": {
            key: "github.repo",
            value: "getsentry/junior",
          },
        },
      },
    });
  });

  it("persists conversation processing/vision without rebuildable stats mirrors", async () => {
    const conversationId = "local:test:thread-scratch-thin-conversation";
    const conversation = coerceThreadConversationState({
      conversation: {
        processing: {
          activeTurnId: "turn-thin",
          lastCompletedAtMs: 42,
        },
        vision: {
          backfillCompletedAtMs: 99,
          byFileId: {
            F1: { summary: "diagram of auth flow", analyzedAtMs: 100 },
          },
        },
        backfill: {
          completedAtMs: 7,
          source: "thread_fetch",
        },
        stats: {
          estimatedContextTokens: 1234,
          totalMessageCount: 9,
          compactedMessageCount: 3,
          updatedAtMs: 8,
        },
      },
    });

    await persistThreadStateById(conversationId, { conversation });

    const state = await getPersistedThreadState(conversationId);
    expect(state.conversation).toMatchObject({
      schemaVersion: 1,
      processing: {
        activeTurnId: "turn-thin",
        lastCompletedAtMs: 42,
      },
      vision: {
        backfillCompletedAtMs: 99,
        byFileId: {
          F1: { summary: "diagram of auth flow", analyzedAtMs: 100 },
        },
      },
    });
    expect(state.conversation).not.toHaveProperty("stats");
    expect(state.conversation).not.toHaveProperty("backfill");
    expect(state.conversation).not.toHaveProperty("messages");
    expect(state.conversation).not.toHaveProperty("compactions");
  });
});
