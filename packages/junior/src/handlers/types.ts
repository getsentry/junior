/** Callback to schedule background work that must finish before the function exits. */
export type WaitUntilFn = (
  task: Promise<unknown> | (() => Promise<unknown>),
) => void;
