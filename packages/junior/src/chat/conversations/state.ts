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
    recordActivity: (args) =>
      recordTaskConversationActivity({ ...args, state }),
    recordExecution: (args) =>
      recordTaskConversationExecution({ ...args, state }),
    listByActivity: (args) =>
      listTaskConversationsByActivity({ ...args, state }),
  };
}
