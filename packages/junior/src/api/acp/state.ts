import type { Lock, StateAdapter } from "chat";

/** One lock held in shared ACP state. */
export type AcpLock = Lock;

/** Shared state operations required by the ACP transport. */
export type AcpState = Pick<
  StateAdapter,
  | "acquireLock"
  | "appendToList"
  | "delete"
  | "extendLock"
  | "get"
  | "getList"
  | "releaseLock"
  | "set"
>;
