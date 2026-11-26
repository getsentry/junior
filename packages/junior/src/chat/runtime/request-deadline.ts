import { AsyncLocalStorage } from "node:async_hooks";
import { getChatConfig } from "@/chat/config";
import { FUNCTION_TIMEOUT_BUFFER_SECONDS } from "@/config";

export interface TurnRequestDeadline {
  deadlineAtMs: number;
  startedAtMs: number;
}

const requestDeadlineStorage = new AsyncLocalStorage<TurnRequestDeadline>();

function createTurnRequestDeadline(startedAtMs: number): TurnRequestDeadline {
  const requestBudgetMs = Math.max(
    1,
    getChatConfig().functionMaxDurationSeconds * 1000 -
      FUNCTION_TIMEOUT_BUFFER_SECONDS * 1000,
  );
  return {
    startedAtMs,
    deadlineAtMs: startedAtMs + requestBudgetMs,
  };
}

/** Return the host request deadline inherited by the current async turn. */
export function getTurnRequestDeadline(): TurnRequestDeadline | undefined {
  return requestDeadlineStorage.getStore();
}

/** Run work under the current host request deadline, or start one. */
export function runWithTurnRequestDeadline<T>(
  callback: () => T,
  startedAtMs = Date.now(),
): T {
  const existingDeadline = requestDeadlineStorage.getStore();
  if (existingDeadline) {
    return callback();
  }

  return runWithNewTurnRequestDeadline(callback, startedAtMs);
}

/** Run work that a new host request owns, even inside another request. */
export function runWithNewTurnRequestDeadline<T>(
  callback: () => T,
  startedAtMs = Date.now(),
): T {
  return requestDeadlineStorage.run(
    createTurnRequestDeadline(startedAtMs),
    callback,
  );
}
