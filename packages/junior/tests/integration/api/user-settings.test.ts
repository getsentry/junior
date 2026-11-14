import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { readUserSettings, updateUserSettings } from "@/api/user-settings";
import { closeDb, getDb } from "@/chat/db";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { juniorUsers } from "@/db/schema";

describe("user settings", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("keeps the UI choice in preferences and ignores retired keys", async () => {
    const viewer = await resolveViewerUser("settings@example.com");
    if (!viewer) throw new Error("missing viewer");
    // A preference that no setting uses anymore stays in the row.
    await getDb()
      .update(juniorUsers)
      .set({ preferences: { retiredExperiment: true } })
      .where(eq(juniorUsers.id, viewer.id));

    await expect(readUserSettings(viewer.id)).resolves.toMatchObject({
      experimentalUi: false,
    });
    await expect(
      updateUserSettings(viewer.id, { experimentalUi: true }),
    ).resolves.toMatchObject({
      autoArchiveDefault: false,
      experimentalUi: true,
    });
    // A change to another setting keeps the UI choice.
    await expect(
      updateUserSettings(viewer.id, { autoArchiveDefault: true }),
    ).resolves.toMatchObject({
      autoArchiveDefault: true,
      experimentalUi: true,
    });
    await expect(readUserSettings(viewer.id)).resolves.toEqual({
      autoArchiveDefault: true,
      autoArchiveGraceHours: 24,
      experimentalUi: true,
    });
  });
});
