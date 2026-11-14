import { eq, sql } from "drizzle-orm";
import * as z from "zod";
import { getDb } from "@/chat/db";
import { juniorUsers } from "@/db/schema";
import { AUTO_ARCHIVE_DEFAULT_GRACE_HOURS } from "@/db/schema/users";

// Unlike most durable records, reads drop unknown keys: a retired
// preference stays in old rows, and removing its key here retires it with
// no migration.
const userPreferencesSchema = z.object({
  /** Show the new dashboard UI instead of the current one. */
  experimentalUi: z.boolean().optional(),
});

type UserPreferences = z.output<typeof userPreferencesSchema>;

/** A user's dashboard settings: auto-archive and the UI choice. */
export type UserSettings = {
  autoArchiveDefault: boolean;
  autoArchiveGraceHours: number;
  experimentalUi: boolean;
};

/** Settings of a user who has not changed any. */
export const DEFAULT_USER_SETTINGS: UserSettings = {
  autoArchiveDefault: false,
  autoArchiveGraceHours: AUTO_ARCHIVE_DEFAULT_GRACE_HOURS,
  experimentalUi: false,
};

const userSettingsColumns = {
  autoArchiveDefault: juniorUsers.autoArchiveDefault,
  autoArchiveGraceHours: juniorUsers.autoArchiveGraceHours,
  preferences: juniorUsers.preferences,
};

function toUserSettings(
  row: { preferences: unknown } & Omit<UserSettings, "experimentalUi">,
): UserSettings {
  const { preferences, ...columns } = row;
  const parsed = userPreferencesSchema.parse(preferences);
  return {
    ...columns,
    experimentalUi:
      parsed.experimentalUi ?? DEFAULT_USER_SETTINGS.experimentalUi,
  };
}

/** Read the user's dashboard settings. */
export async function readUserSettings(
  userId: string,
): Promise<UserSettings | undefined> {
  const [user] = await getDb()
    .select(userSettingsColumns)
    .from(juniorUsers)
    .where(eq(juniorUsers.id, userId))
    .limit(1);
  return user && toUserSettings(user);
}

/** Save changed dashboard settings and return the saved settings. */
export async function updateUserSettings(
  userId: string,
  settings: Partial<UserSettings>,
): Promise<UserSettings | undefined> {
  const { experimentalUi, ...columns } = settings;
  const preferences: UserPreferences =
    experimentalUi === undefined ? {} : { experimentalUi };
  const [user] = await getDb()
    .update(juniorUsers)
    .set({
      ...columns,
      // Merge in SQL, so concurrent changes to other keys are kept.
      preferences: sql`${juniorUsers.preferences} || ${JSON.stringify(preferences)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(juniorUsers.id, userId))
    .returning(userSettingsColumns);
  return user && toUserSettings(user);
}
