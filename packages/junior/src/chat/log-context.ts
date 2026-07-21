import { AsyncLocalStorage } from "node:async_hooks";

export type LogAttributeValue = string | number | boolean | string[];
export type LogAttributes = Record<string, LogAttributeValue>;

/** Async context domain inherited by logs and spans in the current operation. */
export const logContextStorage = new AsyncLocalStorage<LogAttributes>();

function mergeLogAttributes(
  current: LogAttributes | undefined,
  next: LogAttributes,
): LogAttributes {
  return { ...current, ...next };
}

/** Run an operation with additional log attributes without changing its callers. */
export function bindLogAttributes<T>(
  attributes: LogAttributes,
  callback: () => T,
): T {
  return logContextStorage.run(
    mergeLogAttributes(logContextStorage.getStore(), attributes),
    callback,
  );
}

/** Add log attributes to the current async operation. */
export function extendLogAttributes(attributes: LogAttributes): void {
  logContextStorage.enterWith(
    mergeLogAttributes(logContextStorage.getStore(), attributes),
  );
}

/** Read the attributes bound to the current async operation. */
export function getBoundLogAttributes(): LogAttributes {
  return logContextStorage.getStore() ?? {};
}
