import type { CodeChangePublisher } from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import { associateCodeChangeConversations, recordCodeChange } from "./store";

/** Connect a plugin to Junior's code records. */
export function createCodeChangePublisher(
  provider: string,
): CodeChangePublisher {
  return {
    async associateConversations(input) {
      await associateCodeChangeConversations(getDb(), provider, input);
    },
    async record(input) {
      await recordCodeChange(getDb(), provider, input);
    },
  };
}
