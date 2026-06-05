import { disconnectStateAdapter } from "@/chat/state/adapter";
import { afterEach, beforeEach, vi } from "vitest";

type TestEnvValues = Readonly<Record<string, string | undefined>>;

/** Apply Vitest-managed env overrides so test cleanup can restore them safely. */
export function stubTestEnv(values: TestEnvValues): void {
  for (const [name, value] of Object.entries(values)) {
    vi.stubEnv(name, value);
  }
}

/** Isolate suites that exercise shared state through the memory adapter. */
export function useMemoryStateAdapter(): void {
  beforeEach(async () => {
    stubTestEnv({ JUNIOR_STATE_ADAPTER: "memory" });
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
  });
}

/** Restore real timers after suites that use fake time for one or more cases. */
export function useRealTimersAfterEach(): void {
  afterEach(() => {
    vi.useRealTimers();
  });
}
