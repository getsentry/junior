import { vi } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";

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

/** Build a Pi text message fixture for turn-session record boundaries. */
export function piTextMessage(
  role: PiMessage["role"],
  text: string,
  timestamp: number,
  extra: Record<string, unknown> = {},
): PiMessage {
  return {
    role,
    ...extra,
    content: [{ type: "text", text }],
    timestamp,
  } as PiMessage;
}
