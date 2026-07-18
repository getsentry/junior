import { createMemoryState } from "@chat-adapter/state-memory";
import type { StateAdapter } from "chat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTHORIZATION_RECOVERY_INDEX_MAX_ENTRIES,
  listAuthorizationRecoveries,
  registerAuthorizationRecovery,
} from "@/chat/state/authorization-recovery-index";

const INDEX_KEY = "junior:agent_turn_authorization_recovery:index";

describe("authorization recovery index", () => {
  let state: StateAdapter;

  beforeEach(async () => {
    state = createMemoryState();
    await state.connect();
  });

  afterEach(async () => {
    await state.disconnect();
  });

  it("rejects a new entry at capacity without evicting live entries", async () => {
    const registeredAtMs = Date.now();
    await state.set(
      INDEX_KEY,
      Array.from(
        { length: AUTHORIZATION_RECOVERY_INDEX_MAX_ENTRIES },
        (_, index) => ({
          authorizationCompletionId: `completion-${index}`,
          conversationId: `conversation-${index}`,
          registeredAtMs,
          sessionId: `session-${index}`,
        }),
      ),
    );

    await registerAuthorizationRecovery(state, {
      authorizationCompletionId: "completion-0",
      conversationId: "conversation-0",
      registeredAtMs: registeredAtMs + 1,
      sessionId: "session-0",
    });
    await expect(
      registerAuthorizationRecovery(state, {
        authorizationCompletionId: "overflow-completion",
        conversationId: "overflow-conversation",
        registeredAtMs,
        sessionId: "overflow-session",
      }),
    ).rejects.toThrow("Authorization recovery index is at capacity");

    const entries = await listAuthorizationRecoveries(state);
    expect(entries).toHaveLength(AUTHORIZATION_RECOVERY_INDEX_MAX_ENTRIES);
    expect(entries[0]).toMatchObject({ registeredAtMs: registeredAtMs + 1 });
    expect(entries).not.toContainEqual(
      expect.objectContaining({
        authorizationCompletionId: "overflow-completion",
      }),
    );
  });

  it("rejects malformed or oversized persisted indexes", async () => {
    await state.set(
      INDEX_KEY,
      Array.from(
        { length: AUTHORIZATION_RECOVERY_INDEX_MAX_ENTRIES + 1 },
        () => ({}),
      ),
    );
    await expect(listAuthorizationRecoveries(state)).rejects.toThrow(
      "Authorization recovery index exceeds capacity",
    );

    await state.set(INDEX_KEY, [{}]);
    await expect(listAuthorizationRecoveries(state)).rejects.toThrow(
      "Authorization recovery index is malformed",
    );
  });
});
