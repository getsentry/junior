import { vi } from "vitest";
import type * as TurnSessionRecordModule from "@/chat/services/turn-session-record";

const ORIGINAL_ENV = { ...process.env };

type TurnSessionRecordServices = NonNullable<
  Parameters<typeof TurnSessionRecordModule.persistRunningSessionRecord>[1]
>;

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

/** Build explicit turn-session persistence services for failure-path tests. */
export function createTurnSessionRecordServices(
  overrides: Partial<TurnSessionRecordServices> = {},
): TurnSessionRecordServices {
  return {
    getActiveTraceId: vi.fn(() => undefined),
    getAgentTurnSessionRecord: vi.fn(async () => undefined),
    logException: vi.fn(),
    upsertAgentTurnSessionRecord: vi.fn(async (record) => ({
      ...record,
      cumulativeDurationMs: record.cumulativeDurationMs ?? 0,
      lastProgressAtMs: 1,
      startedAtMs: 1,
      updatedAtMs: 1,
      version: 1,
    })),
    ...overrides,
  };
}
