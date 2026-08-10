import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPersistedSandboxState,
  getPersistedThreadState,
  loadThreadRuntimeState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import {
  JUNIOR_ACTIVE_THREAD_STATE_TTL_MS,
  JUNIOR_TERMINAL_THREAD_STATE_TTL_MS,
} from "@/chat/state/ttl";

const originalStateAdapter = process.env.JUNIOR_STATE_ADAPTER;

function emptyConversation(processing: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    compactions: [],
    messages: [],
    processing,
    vision: { byFileId: {} },
  };
}

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
    expect(state).toEqual({});
    expect(getPersistedSandboxState(state)).toBeUndefined();
  });

  it("uses the active TTL while processing is running or paused", async () => {
    const stateAdapter = getStateAdapter();
    const set = vi.spyOn(stateAdapter, "set");
    const conversationId = "local:test:thread-active-ttl";

    await persistThreadStateById(conversationId, {
      conversation: emptyConversation({ activeTurnId: "turn-1" }),
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

    set.mockClear();
    await persistThreadStateById(conversationId, {
      conversation: emptyConversation({
        pendingAuth: {
          kind: "plugin",
          provider: "github",
          actorId: "U123",
          sessionId: "turn-1",
          linkSentAtMs: 10,
        },
      }),
    });

    expect(set).toHaveBeenCalledWith(
      `thread-state:${conversationId}`,
      expect.objectContaining({
        conversation: expect.objectContaining({
          processing: expect.objectContaining({
            pendingAuth: expect.objectContaining({ kind: "plugin" }),
          }),
        }),
      }),
      JUNIOR_ACTIVE_THREAD_STATE_TTL_MS,
    );
  });

  it("uses the terminal grace TTL when scratch is idle", async () => {
    const stateAdapter = getStateAdapter();
    const set = vi.spyOn(stateAdapter, "set");
    const conversationId = "local:test:thread-terminal-ttl";

    await persistThreadStateById(conversationId, {
      conversation: emptyConversation({ lastCompletedAtMs: 99 }),
      sandboxRef: { id: "sandbox-idle" },
    });

    expect(set).toHaveBeenCalledWith(
      `thread-state:${conversationId}`,
      expect.objectContaining({
        app_sandbox_id: "sandbox-idle",
        conversation: expect.objectContaining({
          processing: { lastCompletedAtMs: 99 },
        }),
      }),
      JUNIOR_TERMINAL_THREAD_STATE_TTL_MS,
    );
  });

  it("deletes empty idle scratch instead of retaining a blank bag", async () => {
    const conversationId = "local:test:thread-empty-delete";
    const stateAdapter = getStateAdapter();
    const del = vi.spyOn(stateAdapter, "delete");

    await persistThreadStateById(conversationId, {
      conversation: emptyConversation({ activeTurnId: "turn-1" }),
      sandboxRef: { id: "sandbox-tmp" },
    });

    await persistThreadStateById(conversationId, {
      conversation: emptyConversation(),
      sandboxRef: null,
    });

    expect(del).toHaveBeenCalledWith(`thread-state:${conversationId}`);
    await expect(getPersistedThreadState(conversationId)).resolves.toEqual({});
  });

  it("loads coerced runtime parts from one helper", async () => {
    const conversationId = "local:test:thread-load-runtime";
    await persistThreadStateById(conversationId, {
      conversation: emptyConversation({ activeTurnId: "turn-1" }),
      sandboxRef: { id: "sandbox-load", profileHash: "hash-load" },
    });

    await expect(loadThreadRuntimeState(conversationId)).resolves.toEqual({
      conversation: expect.objectContaining({
        processing: { activeTurnId: "turn-1" },
      }),
      sandboxRef: { id: "sandbox-load", profileHash: "hash-load" },
    });
  });
});
