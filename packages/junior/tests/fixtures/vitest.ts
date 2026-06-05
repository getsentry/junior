import { disconnectStateAdapter } from "@/chat/state/adapter";
import { afterEach, beforeEach, vi } from "vitest";

type TestEnvValues = Readonly<Record<string, string | undefined>>;
type TestClockValue = Date | number | string;

export const DEFAULT_TEST_NOW_ISO = "2026-06-05T12:00:00.000Z";
export const DEFAULT_TEST_NOW_MS = Date.parse(DEFAULT_TEST_NOW_ISO);

function toTestDate(value: TestClockValue): Date {
  return value instanceof Date ? value : new Date(value);
}

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

/** Freeze Date/timers at the shared default test clock unless overridden. */
export function mockTestClock(
  value: TestClockValue = DEFAULT_TEST_NOW_MS,
): void {
  vi.useFakeTimers();
  vi.setSystemTime(toTestDate(value));
}

/** Apply the shared mocked clock around every test in a suite. */
export function useMockedTestClock(
  value: TestClockValue = DEFAULT_TEST_NOW_MS,
): void {
  beforeEach(() => {
    mockTestClock(value);
  });

  afterEach(() => {
    vi.useRealTimers();
  });
}

/** Restore real timers after suites that use fake time for one or more cases. */
export function useRealTimersAfterEach(): void {
  afterEach(() => {
    vi.useRealTimers();
  });
}
