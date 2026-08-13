import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPersistedSandboxState,
  getPersistedThreadState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
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

  it("final fallback still clears when null is preserved after failed inline write", async () => {
    // Mirrors durability adapters: keep null in the local variable so a later
    // persist can clear even if an earlier onSandboxRefChanged write failed.
    const conversationId = "local:test:thread-sandbox-null-fallback";
    await persistThreadStateById(conversationId, {
      sandboxRef: { id: "sandbox-stale", profileHash: "profile-stale" },
    });

    let sandboxRef: { id: string; profileHash?: string } | null | undefined = {
      id: "sandbox-stale",
      profileHash: "profile-stale",
    };
    const resultSandboxRef: { id: string } | null | undefined = null;

    // Inline clear signal collapses only when coerced with ?? undefined.
    sandboxRef = null;
    await persistThreadStateById(conversationId, {
      sandboxRef:
        resultSandboxRef !== undefined ? resultSandboxRef : sandboxRef,
    });

    const state = await getPersistedThreadState(conversationId);
    expect(getPersistedSandboxState(state)).toBeUndefined();
    expect(state).toMatchObject({
      app_sandbox_id: "",
      app_sandbox_dependency_profile_hash: "",
    });
  });

  it("writes thread scratch with Junior's 7-day TTL", async () => {
    const stateAdapter = getStateAdapter();
    const set = vi.spyOn(stateAdapter, "set");
    const conversationId = "local:test:thread-scratch-ttl";
    await persistThreadStateById(conversationId, {
      sandboxRef: { id: "sandbox-ttl" },
    });
    expect(set).toHaveBeenCalledWith(
      `thread-state:${conversationId}`,
      expect.objectContaining({ app_sandbox_id: "sandbox-ttl" }),
      JUNIOR_THREAD_STATE_TTL_MS,
    );
  });
});
