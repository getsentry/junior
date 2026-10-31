import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createSlackActor } from "@/chat/actor";
import { getDb } from "@/chat/db";
import { saveSlackActorAvatar } from "@/chat/slack/avatar";
import { juniorIdentities } from "@/db/schema";
import { usersInfoOk } from "../../fixtures/slack/factories/api";
import { queueSlackApiResponse } from "../../msw/handlers/slack-api";

const TEAM_ID = "T0AVATAR";

/** Save the photo of one Slack user, then read their saved Slack photo. */
async function savedSlackPhoto(userId: string, isCustomImage: boolean) {
  queueSlackApiResponse("users.info", {
    body: usersInfoOk({
      userId,
      email: `${userId.toLowerCase()}@example.com`,
      isCustomImage,
    }),
  });
  await saveSlackActorAvatar(createSlackActor(TEAM_ID, userId, null));
  const rows = await getDb()
    .select({ avatarUrl: juniorIdentities.avatarUrl })
    .from(juniorIdentities)
    .where(
      and(
        eq(juniorIdentities.provider, "slack"),
        eq(juniorIdentities.providerTenantId, TEAM_ID),
        eq(juniorIdentities.providerSubjectId, userId),
      ),
    );
  return rows.map((row) => row.avatarUrl);
}

describe("Slack actor profile photo", () => {
  it("saves the photo that a person set in Slack", async () => {
    expect(await savedSlackPhoto("U0PHOTO", true)).toEqual([
      "https://avatars.slack-edge.com/U0PHOTO_512.png",
    ]);
  });

  it("does not save Slack's default photo", async () => {
    expect(await savedSlackPhoto("U0DEFAULT", false)).toEqual([null]);
  });
});
