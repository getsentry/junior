import { vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

type StateAdapterModule = typeof import("@/chat/state/adapter");
type SlackResumeModule = typeof import("@/chat/runtime/slack-resume");
type TurnSessionStoreModule = typeof import("@/chat/state/turn-session");

type ResumeOutcome = "success" | "execution_failure" | "provider_error";

/** Build deterministic assistant diagnostics for OAuth resume Slack tests. */
export function makeResumeDiagnostics(
  outcome: ResumeOutcome = "success",
  extras: Record<string, unknown> = {},
) {
  return {
    assistantMessageCount: 1,
    modelId: "fake-agent-model",
    outcome,
    toolCalls: [],
    toolErrorCount: 0,
    toolResultCount: 0,
    usedPrimaryText: true,
    ...extras,
  };
}

/** Starts the memory-backed Slack OAuth resume integration fixture. */
export async function createOauthResumeSlackFixture() {
  process.env = {
    ...ORIGINAL_ENV,
    JUNIOR_STATE_ADAPTER: "memory",
  };
  vi.resetModules();

  const stateAdapter: StateAdapterModule = await import("@/chat/state/adapter");
  await stateAdapter.disconnectStateAdapter();
  const slackResume: SlackResumeModule =
    await import("@/chat/runtime/slack-resume");
  const turnSessionStore: TurnSessionStoreModule =
    await import("@/chat/state/turn-session");

  return {
    resumeAuthorizedRequest: slackResume.resumeAuthorizedRequest,
    turnSessionStore,

    /** Disconnects memory state and restores the test environment. */
    async cleanup() {
      await stateAdapter.disconnectStateAdapter();
      process.env = { ...ORIGINAL_ENV };
    },
  };
}
