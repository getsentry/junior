import { afterEach } from "vitest";
import { drainEvalWork } from "./eval-work";

// Register last: case work must settle before MSW and database cleanup.
// Do not let a hook timeout start the next case with dirty state. CI bounds
// stalled cleanup with the job timeout instead of a competing worker deadline.
afterEach(async (context) => {
  await drainEvalWork(context);
}, 0);
