/**
 * Repair Slack destination visibility after migration 0002 over-aggressively
 * reset all confirmed-public destinations to 'private'.
 *
 * TODO(0.90): Remove this migration once all deployments have run it and
 * destination rows have been re-confirmed by the live Slack Events API.
 *
 * Uses the Slack conversations.info API to confirm actual channel visibility
 * for ambiguous C-prefixed destinations. DMs and group/private channels are
 * left untouched; only 'channel'-kind rows are re-evaluated.
 *
 * This upgrade migration is safe to re-run: already-public rows are skipped,
 * and the migration proceeds even if individual channels are unreachable.
 * It skips entirely when no Slack bot token is configured.
 */
import { and, eq, ne } from "drizzle-orm";
import { juniorDestinations } from "@/chat/conversations/sql/schema";
import type { JuniorSqlExecutor } from "@/chat/sql/db";
import { createJuniorSqlExecutor } from "@/chat/sql/executor";
import { getSlackClient, withSlackRetries } from "@/chat/slack/client";
import type { MigrationContext, MigrationResult } from "../types";

const REPAIR_QUERY_LIMIT = 1_000;

/** Resolved classification for one Slack channel. */
type ChannelVisibilityResult =
  | { kind: "public" }
  | { kind: "private" }
  | { kind: "skipped" };

/**
 * Call conversations.info once for a channel and map Slack's is_private field
 * to a visibility result. Returns 'skipped' on any API error so callers
 * never update visibility from an uncertain state.
 */
async function resolveChannelVisibility(
  channelId: string,
  infoFn: (id: string) => Promise<ChannelVisibilityResult>,
): Promise<ChannelVisibilityResult> {
  try {
    return await infoFn(channelId);
  } catch {
    return { kind: "skipped" };
  }
}

/** Build a conversations.info lookup backed by the live Slack WebClient. */
function liveInfoFn(): (id: string) => Promise<ChannelVisibilityResult> {
  return async (channelId) => {
    const response = await withSlackRetries(
      async () => getSlackClient().conversations.info({ channel: channelId }),
      3,
      { action: "conversations.info", idempotent: true },
    );
    return { kind: response.channel?.is_private ? "private" : "public" };
  };
}

/** Repair Slack destination visibility using the Slack conversations.info API. */
export async function repairSlackDestinationVisibility(
  _context: MigrationContext,
  options: {
    /** Injected SQL executor; defaults to the configured database. */
    executor?: JuniorSqlExecutor;
    /** Injected Slack info function; defaults to the live WebClient. */
    slackInfoFn?: (channelId: string) => Promise<ChannelVisibilityResult>;
  } = {},
): Promise<MigrationResult> {
  const { getSlackBotToken, getChatConfig } = await import("@/chat/config");

  if (!getSlackBotToken()) {
    // No token means no Slack context to repair; skip silently.
    return { existing: 0, migrated: 0, missing: 0, scanned: 0 };
  }

  const infoFn = options.slackInfoFn ?? liveInfoFn();

  let executor = options.executor;
  let closeExecutor: (() => Promise<void>) | undefined;
  if (!executor) {
    const { sql } = getChatConfig();
    const created = createJuniorSqlExecutor({
      connectionString: sql.databaseUrl,
      driver: sql.driver,
    });
    executor = created;
    closeExecutor = () => created.close();
  }

  try {
    const db = executor.db();

    // Only 'channel'-kind rows are ambiguous: DMs ('dm') and legacy private
    // channels ('group') are definitively private by channel-ID prefix and
    // need no Slack API confirmation.
    const rows = await db
      .select({
        id: juniorDestinations.id,
        providerDestinationId: juniorDestinations.providerDestinationId,
      })
      .from(juniorDestinations)
      .where(
        and(
          eq(juniorDestinations.provider, "slack"),
          eq(juniorDestinations.kind, "channel"),
          ne(juniorDestinations.visibility, "public"),
        ),
      )
      .limit(REPAIR_QUERY_LIMIT);

    const nowMs = Date.now();
    let migrated = 0;
    let skipped = 0;

    for (const row of rows) {
      const result = await resolveChannelVisibility(
        row.providerDestinationId,
        infoFn,
      );

      if (result.kind === "public") {
        await db
          .update(juniorDestinations)
          .set({ visibility: "public", updatedAt: new Date(nowMs) })
          .where(eq(juniorDestinations.id, row.id));
        migrated++;
      } else if (result.kind === "skipped") {
        skipped++;
      }
      // 'private': already correct, no update needed
    }

    return {
      existing: rows.length - migrated - skipped,
      migrated,
      missing: 0,
      scanned: rows.length,
      skipped,
    };
  } finally {
    await closeExecutor?.();
  }
}

export const slackDestinationVisibilityRepairMigration = {
  name: "repair-slack-destination-visibility",
  run: repairSlackDestinationVisibility,
};
