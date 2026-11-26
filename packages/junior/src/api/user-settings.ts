import { eq } from "drizzle-orm";
import { getDb } from "@/chat/db";
import { juniorUsers } from "@/db/schema";
import { AUTO_ARCHIVE_DEFAULT_GRACE_HOURS } from "@/db/schema/users";

/** A user's dashboard settings: auto-archive. */
export type UserSettings = {
  autoArchiveDefault: boolean;
  autoArchiveGraceHours: number;
};

/** Settings of a user who has not changed any. */
export const DEFAULT_USER_SETTINGS: UserSettings = {
  autoArchiveDefault: false,
  autoArchiveGraceHours: AUTO_ARCHIVE_DEFAULT_GRACE_HOURS,
};

const userSettingsColumns = {
  autoArchiveDefault: juniorUsers.autoArchiveDefault,
  autoArchiveGraceHours: juniorUsers.autoArchiveGraceHours,
};

/** Read the user's dashboard settings. */
export async function readUserSettings(
  userId: string,
): Promise<UserSettings | undefined> {
  const [user] = await getDb()
    .select(userSettingsColumns)
    .from(juniorUsers)
    .where(eq(juniorUsers.id, userId))
    .limit(1);
  return user;
}

/** Save changed dashboard settings and return the saved settings. */
export async function updateUserSettings(
  userId: string,
  settings: Partial<UserSettings>,
): Promise<UserSettings | undefined> {
  const [user] = await getDb()
    .update(juniorUsers)
    .set({ ...settings, updatedAt: new Date() })
    .where(eq(juniorUsers.id, userId))
    .returning(userSettingsColumns);
  return user;
}
