import {
  getConversation as getTaskConversation,
  listConversationsByActivity as listTaskConversationsByActivity,
  recordConversationActivity as recordTaskConversationActivity,
  recordConversationExecution as recordTaskConversationExecution,
} from "@/chat/task-execution/state";
import type { StateAdapter } from "chat";
import type { ConversationStore } from "./store";

/** Create the legacy-import conversation record store backed by task-execution state. */
export function createStateConversationStore(
  state?: StateAdapter,
): ConversationStore {
  return {
    get: (args) => getTaskConversation({ ...args, state }),
    // Task-execution state has no destination records, so visibility is never
    // source-confirmed here and cross-context reads fail closed to private.
    getDestinationVisibility: async () => undefined,
    // Subagent child conversations are a SQL-only concept; the advisor always
    // links its child through the SQL store, never this legacy metadata path.
    ensureChildConversation: async () => undefined,
    recordActivity: (args) =>
      recordTaskConversationActivity({ ...args, state }),
    recordExecution: (args) =>
      recordTaskConversationExecution({ ...args, state }),
    listByActivity: (args) =>
      listTaskConversationsByActivity({ ...args, state }),
  };
}
