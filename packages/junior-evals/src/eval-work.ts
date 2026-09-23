import { TestRunner } from "vitest";

const pendingWork = Symbol("eval pending work");
type WorkOwner = { [pendingWork]?: Set<Promise<unknown>> };

/** Keep work on its Vitest case so outer timeouts cannot skip teardown. */
export function runEvalWork<T>(operation: () => Promise<T>): Promise<T> {
  const owner = TestRunner.getCurrentTest()?.context as WorkOwner | undefined;
  if (!owner) throw new Error("Eval work requires an active Vitest case");
  const pending = (owner[pendingWork] ??= new Set());
  const work = operation();
  pending.add(work);
  void work.then(
    () => pending.delete(work),
    () => pending.delete(work),
  );
  return work;
}

/** Join aborted case work before any shared fixtures are reset. */
export async function drainEvalWork(context: object): Promise<void> {
  const pending = (context as WorkOwner)[pendingWork];
  if (!pending?.size) return;
  // A hook error alone lets Vitest start the next case with dirty state.
  const timer = setTimeout(() => {
    process.stderr.write(
      "Eval work did not stop during teardown; stopping worker\n",
    );
    process.exit(1);
  }, 5_000);
  try {
    while (pending.size) await Promise.allSettled([...pending]);
  } finally {
    clearTimeout(timer);
  }
}
