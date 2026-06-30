import type { WaitUntilFn } from "@/handlers/types";

export const waitUntilCallbacks: Array<() => Promise<unknown> | void> = [];

export const testWaitUntil: WaitUntilFn = (task) => {
  waitUntilCallbacks.push(typeof task === "function" ? task : () => task);
};
