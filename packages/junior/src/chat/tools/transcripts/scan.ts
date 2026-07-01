import {
  transcriptAccess,
  type TranscriptAccess,
} from "@/chat/tools/transcripts/access";
import { MAX_SCAN_LIMIT } from "@/chat/tools/transcripts/constants";
import type { TranscriptConversationStore } from "@/chat/tools/transcripts/deps";
import { scanLimit } from "@/chat/tools/transcripts/limits";
import type { ToolRuntimeContext } from "@/chat/tools/types";

type TranscriptActivityList = Pick<
  TranscriptConversationStore,
  "listByActivity"
>;

/**
 * Visit visible transcript metadata while paging past inaccessible SQL rows.
 *
 * Access checks happen after newest-first SQL paging, but raw rows are still
 * capped by `MAX_SCAN_LIMIT`. Return `true` from `visit` once the caller has
 * collected enough visible results.
 */
export async function visitVisibleTranscripts(args: {
  context: ToolRuntimeContext;
  conversationStore: TranscriptActivityList;
  resultLimit: number;
  visit: (access: TranscriptAccess) => Promise<boolean | void>;
}) {
  const pageLimit = scanLimit(args.resultLimit);
  let offset = 0;
  let scannedCount = 0;

  while (scannedCount < MAX_SCAN_LIMIT) {
    const rows = await args.conversationStore.listByActivity({
      limit: Math.min(pageLimit, MAX_SCAN_LIMIT - scannedCount),
      offset,
    });
    if (rows.length === 0) {
      return;
    }
    offset += rows.length;
    scannedCount += rows.length;

    for (const conversation of rows) {
      const access = transcriptAccess(conversation, args.context);
      if (!access) {
        continue;
      }
      if (await args.visit(access)) {
        return;
      }
    }
  }
}
