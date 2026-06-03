import type { WaitUntilFn } from "@/handlers/types";

/** Collect waitUntil tasks so tests can assert and flush background work explicitly. */
export class WaitUntilCollector {
  #tasks: Promise<unknown>[] = [];

  readonly fn: WaitUntilFn = (task) => {
    this.#tasks.push(typeof task === "function" ? task() : task);
  };

  pendingCount(): number {
    return this.#tasks.length;
  }

  async flush(): Promise<void> {
    while (this.#tasks.length > 0) {
      await this.#tasks.shift();
    }
  }
}

/** Create a waitUntil collector for handler and webhook tests. */
export function createWaitUntilCollector(): WaitUntilCollector {
  return new WaitUntilCollector();
}
