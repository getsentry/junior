import type { PluginCodeChanges } from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import {
  associateCodeChangeConversations,
  listCodeChanges,
  recordCodeChange,
  recordCodeChangeActivity,
  recordCodeRepository,
} from "./store";

/** Connect a plugin to Junior's code records. */
export function createPluginCodeChanges(provider: string): PluginCodeChanges {
  return {
    async associateConversations(input) {
      await associateCodeChangeConversations(getDb(), provider, input);
    },
    async list(filter) {
      return await listCodeChanges(getDb(), provider, filter);
    },
    async record(input) {
      await recordCodeChange(getDb(), provider, input);
    },
    async recordActivity(input) {
      await recordCodeChangeActivity(getDb(), provider, input);
    },
    async recordRepository(input) {
      await recordCodeRepository(getDb(), provider, input);
    },
  };
}
