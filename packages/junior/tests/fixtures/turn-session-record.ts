import { vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

/** Reset module state and use the memory adapter for turn-session record tests. */
export async function setupTurnSessionRecordTest(): Promise<void> {
  process.env = {
    ...ORIGINAL_ENV,
    JUNIOR_STATE_ADAPTER: "memory",
  };
  vi.resetModules();
  const { disconnectStateAdapter } = await import("@/chat/state/adapter");
  await disconnectStateAdapter();
}

/** Restore mocked modules, environment, and memory state after turn-session tests. */
export async function cleanupTurnSessionRecordTest(): Promise<void> {
  const { disconnectStateAdapter } = await import("@/chat/state/adapter");
  await disconnectStateAdapter();
  vi.doUnmock("@/chat/logging");
  vi.doUnmock("@/chat/state/turn-session");
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
}
