import { afterEach } from "vitest";
import { closeDb } from "@/chat/db";
import { drainPendingEvalPluginTasks } from "./behavior-harness";

afterEach(async () => {
  await drainPendingEvalPluginTasks();
  await closeDb();
});
