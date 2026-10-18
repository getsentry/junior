/** Viewer-scoped scheduled-automation mutations. */
import type { User } from "@sentry/junior-plugin-api";
import type { JuniorDatabase } from "@/db/db";
import {
  readScheduledAutomation,
  saveScheduledAutomationInLock,
  withScheduledAutomationLock,
} from "./tasks";

export class PersonalScheduledAutomationNotFoundError extends Error {
  constructor() {
    super("Scheduled automation was not found.");
    this.name = "PersonalScheduledAutomationNotFoundError";
  }
}

/** Delete one scheduled automation created by the viewer. */
export async function deleteViewerScheduledAutomation(
  db: JuniorDatabase,
  user: User,
  id: string,
  nowMs = Date.now(),
): Promise<void> {
  await withScheduledAutomationLock(db, id, async (tx) => {
    const identityIds = new Set(user.identities.map((identity) => identity.id));
    const task = await readScheduledAutomation(tx, id);
    if (
      !task ||
      task.status === "deleted" ||
      !identityIds.has(task.creatorIdentityId)
    ) {
      throw new PersonalScheduledAutomationNotFoundError();
    }
    await saveScheduledAutomationInLock(
      tx,
      {
        ...task,
        nextRunAtMs: undefined,
        runNowAtMs: undefined,
        status: "deleted",
        updatedAtMs: nowMs,
      },
      task,
    );
  });
}
