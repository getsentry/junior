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
import { DEFAULT_SLACK_AUTHOR, SLACK_TEAM_ID } from "./slack";

/** The most memories that the store lists in one call. */
const LIST_LIMIT = 200;

/**
 * Return the active memories that any person can recall, newest first. A
 * memory that Junior forgot or replaced is not in the list.
 */
export async function readMemories(): Promise<MemoryRecord[]> {
  // All memory is public, so the reader's Source does not change the list.
  const store = createMemoryStore(getDb() as unknown as MemoryDb, {
    actor: {
      platform: "slack",
      teamId: SLACK_TEAM_ID,
      userId: DEFAULT_SLACK_AUTHOR.userId,
    },
    source: createSlackSource({
      channelId: `D${DEFAULT_SLACK_AUTHOR.userId}`,
      teamId: SLACK_TEAM_ID,
      visibility: "private",
    }),
  });
  return await store.listMemories({ limit: LIST_LIMIT });
}
