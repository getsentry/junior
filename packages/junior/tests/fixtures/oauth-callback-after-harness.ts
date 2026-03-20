import { vi } from "vitest";

export const afterCallbacks: Array<() => Promise<void> | void> = [];

vi.mock("next/server", () => ({
  after: (callback: () => Promise<void> | void) => {
    afterCallbacks.push(callback);
  },
}));
