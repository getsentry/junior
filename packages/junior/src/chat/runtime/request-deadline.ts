import { AsyncLocalStorage } from "node:async_hooks";
import { FUNCTION_TIMEOUT_BUFFER_SECONDS, getChatConfig } from "@/chat/config";

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

/** Run work with one host request deadline shared by nested queued turns. */
export function runWithTurnRequestDeadline<T>(
  callback: () => T,
  startedAtMs = Date.now(),
): T {
  const existingDeadline = requestDeadlineStorage.getStore();
  if (existingDeadline) {
    return callback();
  }

  return requestDeadlineStorage.run(
    createTurnRequestDeadline(startedAtMs),
    callback,
  );
}
