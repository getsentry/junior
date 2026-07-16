import type { MigrationStateV1 } from "@sentry/junior-migrations";
import type { StateAdapter } from "chat";

/** Project the host state adapter onto the permanent v1 migration capability. */
export function createMigrationStateV1(
  stateAdapter: StateAdapter,
): MigrationStateV1 {
  return {
    acquireLock: async (threadId, ttlMs) =>
      await stateAdapter.acquireLock(threadId, ttlMs),
    appendToList: async (key, value, options) => {
      await stateAdapter.appendToList(key, value, options);
    },
    connect: async () => {
      await stateAdapter.connect();
    },
    delete: async (key) => {
      await stateAdapter.delete(key);
    },
    get: async <T>(key: string) =>
      (await stateAdapter.get<T>(key)) ?? undefined,
    getList: async <T>(key: string) => await stateAdapter.getList<T>(key),
    releaseLock: async (lock) => {
      await stateAdapter.releaseLock(lock);
    },
    set: async (key, value, ttlMs) => {
      await stateAdapter.set(key, value, ttlMs);
    },
    setIfNotExists: async (key, value, ttlMs) =>
      await stateAdapter.setIfNotExists(key, value, ttlMs),
  };
}
