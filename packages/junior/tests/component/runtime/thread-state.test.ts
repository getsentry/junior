import type { Thread } from "chat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPersistedSandboxState,
  getPersistedThreadState,
  loadThreadRuntimeState,
  persistThreadRuntimeState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import {
  JUNIOR_ACTIVE_THREAD_STATE_TTL_MS,
  JUNIOR_THREAD_STATE_TTL_MS,
} from "@/chat/state/ttl";

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

  it("uses the short TTL while processing is active", async () => {
    const stateAdapter = getStateAdapter();
    const set = vi.spyOn(stateAdapter, "set");
    const conversationId = "local:test:thread-active-ttl";

    await persistThreadStateById(conversationId, {
      conversation: {
        schemaVersion: 1,
        compactions: [],
        messages: [],
        processing: { activeTurnId: "turn-1" },
        vision: { byFileId: {} },
      },
      sandboxRef: { id: "sandbox-active" },
    });

    expect(set).toHaveBeenCalledWith(
      `thread-state:${conversationId}`,
      expect.objectContaining({
        app_sandbox_id: "sandbox-active",
        conversation: expect.objectContaining({
          processing: { activeTurnId: "turn-1" },
        }),
      }),
      JUNIOR_ACTIVE_THREAD_STATE_TTL_MS,
    );
  });

  it("uses the cache TTL when processing is idle", async () => {
    const stateAdapter = getStateAdapter();
    const set = vi.spyOn(stateAdapter, "set");
    const conversationId = "local:test:thread-scratch-ttl";
    const thread = {
      id: conversationId,
      channelId: "C-scratch-ttl",
      channel: { id: "C-scratch-ttl" },
    } as Thread;

    await persistThreadRuntimeState(thread, {
      artifacts: { lastCanvasId: "Fcanvas" },
      sandboxRef: { id: "sandbox-ttl" },
    });

    expect(set).toHaveBeenCalledWith(
      `thread-state:${conversationId}`,
      expect.objectContaining({
        app_sandbox_id: "sandbox-ttl",
        artifacts: expect.objectContaining({ lastCanvasId: "Fcanvas" }),
      }),
      JUNIOR_THREAD_STATE_TTL_MS,
    );
  });

  it("loads coerced runtime parts from one helper", async () => {
    const conversationId = "local:test:thread-load-runtime";
    await persistThreadStateById(conversationId, {
      artifacts: { lastCanvasId: "Fcanvas" },
      conversation: {
        schemaVersion: 1,
        compactions: [],
        messages: [],
        processing: { activeTurnId: "turn-1" },
        vision: { byFileId: {} },
      },
      sandboxRef: { id: "sandbox-load", profileHash: "hash-load" },
    });

    await expect(loadThreadRuntimeState(conversationId)).resolves.toEqual({
      artifacts: expect.objectContaining({ lastCanvasId: "Fcanvas" }),
      conversation: expect.objectContaining({
        processing: { activeTurnId: "turn-1" },
      }),
      sandboxRef: { id: "sandbox-load", profileHash: "hash-load" },
    });
  });
});
