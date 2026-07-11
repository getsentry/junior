import { z } from "zod";
import { piMessageSchema, type PiMessage } from "@/chat/pi/messages";
import { getStateAdapter } from "@/chat/state/adapter";

// TODO(v0.95.0): Remove this reader with the bounded Redis-to-SQL import path
// after the legacy import horizon.
const legacyAdvisorMessagesSchema = z.array(piMessageSchema);

/** Read historical advisor messages during the bounded Redis-to-SQL import. */
export interface LegacyAdvisorSessionReader {
  load: (conversationId: string) => Promise<PiMessage[]>;
}

function key(conversationId: string): string {
  return `junior:${conversationId}:advisor_session`;
}

/** Create the load-only reader for historical advisor session blobs. */
export function createLegacyAdvisorSessionReader(): LegacyAdvisorSessionReader {
  return {
    load: async (conversationId) => {
      const stateAdapter = getStateAdapter();
      await stateAdapter.connect();
      return legacyAdvisorMessagesSchema.parse(
        structuredClone(
          (await stateAdapter.get<unknown>(key(conversationId))) ?? [],
        ),
      );
    },
  };
}
