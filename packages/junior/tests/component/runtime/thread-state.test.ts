import type { Thread } from "chat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPersistedSandboxState,
  getPersistedThreadState,
  persistThreadRuntimeState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import {
  JUNIOR_PROCESSING_STATE_TTL_MS,
  JUNIOR_SANDBOX_REF_TTL_MS,
  JUNIOR_TERMINAL_PROCESSING_STATE_TTL_MS,
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

  it("uses the sandbox lifetime for sandbox references", async () => {
    const stateAdapter = getStateAdapter();
    const set = vi.spyOn(stateAdapter, "set");
    const conversationId = "local:test:thread-sandbox-ttl";

    await persistThreadStateById(conversationId, {
      sandboxRef: { id: "sandbox-ttl" },
    });

    expect(set).toHaveBeenCalledWith(
      `thread-sandbox-ref:${conversationId}`,
      { id: "sandbox-ttl" },
      JUNIOR_SANDBOX_REF_TTL_MS,
    );
  });

  it("deletes the sandbox key when the reference is cleared", async () => {
    const stateAdapter = getStateAdapter();
    const deleteState = vi.spyOn(stateAdapter, "delete");
    const conversationId = "local:test:thread-sandbox-delete";

    await persistThreadStateById(conversationId, { sandboxRef: null });

    expect(deleteState).toHaveBeenCalledWith(
      `thread-sandbox-ref:${conversationId}`,
    );
  });

  it("uses the paused-turn window for processing control", async () => {
    const stateAdapter = getStateAdapter();
    const set = vi.spyOn(stateAdapter, "set");
    const conversationId = "local:test:thread-processing-ttl";

    await persistThreadStateById(conversationId, {
      conversation: {
        schemaVersion: 1,
        compactions: [],
        messages: [],
        processing: { activeTurnId: "turn-1" },
        vision: { byFileId: {} },
      },
    });

    expect(set).toHaveBeenCalledWith(
      `thread-processing-state:${conversationId}`,
      { activeTurnId: "turn-1" },
      JUNIOR_PROCESSING_STATE_TTL_MS,
    );
  });

  it("keeps a short terminal marker when processing clears", async () => {
    const stateAdapter = getStateAdapter();
    const set = vi.spyOn(stateAdapter, "set");
    const conversationId = "local:test:thread-processing-terminal";

    await persistThreadStateById(conversationId, {
      conversation: {
        schemaVersion: 1,
        compactions: [],
        messages: [],
        processing: {},
        vision: { byFileId: {} },
      },
    });

    expect(set).toHaveBeenCalledWith(
      `thread-processing-state:${conversationId}`,
      {},
      JUNIOR_TERMINAL_PROCESSING_STATE_TTL_MS,
    );
  });

  it("keeps artifact and vision cache writes on the cache TTL", async () => {
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
    });

    expect(set).toHaveBeenCalledWith(
      `thread-state:${conversationId}`,
      expect.objectContaining({
        artifacts: expect.objectContaining({ lastCanvasId: "Fcanvas" }),
      }),
      JUNIOR_THREAD_STATE_TTL_MS,
    );
  });
});
