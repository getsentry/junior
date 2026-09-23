import { afterEach } from "vitest";
import { drainEvalWork } from "./eval-work";

// Register last: case work must settle before MSW and database cleanup.
afterEach(async (context) => {
  await drainEvalWork(context);
});
