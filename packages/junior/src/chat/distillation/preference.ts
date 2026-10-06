import { eq } from "drizzle-orm";
import { botConfig } from "@/chat/config";
import { getDb } from "@/chat/db";
import { juniorUsers } from "@/db/schema";

/** Show the opt-in only when this deployment includes the user. */
export function distillationAvailableForUser(userId: string): boolean {
  return (
    botConfig.contextDistillationEnabled &&
    (botConfig.contextDistillationUserIds.length === 0 ||
      botConfig.contextDistillationUserIds.includes(userId))
  );
}

/** Read the durable opt-in for one linked User. Missing users are not opted in. */
export async function readDistillationPreference(
  userId: string,
): Promise<boolean> {
  const [row] = await getDb()
    .select({ enabled: juniorUsers.contextDistillationEnabled })
    .from(juniorUsers)
    .where(eq(juniorUsers.id, userId))
    .limit(1);
  return row?.enabled === true;
}

/** Update only the authenticated User's opt-in. */
export async function updateDistillationPreference(
  userId: string,
  enabled: boolean,
): Promise<boolean | undefined> {
  const [row] = await getDb()
    .update(juniorUsers)
    .set({ contextDistillationEnabled: enabled, updatedAt: new Date() })
    .where(eq(juniorUsers.id, userId))
    .returning({ enabled: juniorUsers.contextDistillationEnabled });
  return row?.enabled;
}
