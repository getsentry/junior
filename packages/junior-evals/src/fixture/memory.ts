/**
 * Stored memories for tests that run the agent with the memory plugin.
 *
 * `readMemories()` reads through the store of the memory plugin, as
 * `insertMemory()` writes through it. Tests do not read memory tables.
 */
import {
  createMemoryStore,
  type MemoryDb,
  type MemoryRecord,
} from "@sentry/junior-memory";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import { readActorIdentity } from "@/chat/plugins/viewer";
import type { SlackAuthor } from "./inputs";
import { DEFAULT_SLACK_AUTHOR, SLACK_TEAM_ID } from "./slack";

/** The most memories that the store lists in one call. */
const LIST_LIMIT = 200;

/**
 * Return the active memories that a Slack person can recall, newest first:
 * each public memory and the private memories of that person. A memory that
 * Junior forgot or replaced is not in the list.
 */
export async function readMemories(
  args: { author?: SlackAuthor } = {},
): Promise<MemoryRecord[]> {
  const actor = {
    platform: "slack" as const,
    teamId: SLACK_TEAM_ID,
    userId: args.author?.userId ?? DEFAULT_SLACK_AUTHOR.userId,
  };
  const userId = (await readActorIdentity(actor))?.user?.id;
  const store = createMemoryStore(getDb() as unknown as MemoryDb, {
    actor,
    // The store lists by User. It does not use the Source of the reader.
    source: createSlackSource({
      channelId: `D${actor.userId}`,
      teamId: SLACK_TEAM_ID,
      visibility: "private",
    }),
    ...(userId ? { userId } : undefined),
  });
  return await store.listMemories({ limit: LIST_LIMIT });
}
