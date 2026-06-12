import {
  getConversation as getTaskConversation,
  listConversationsByActivity as listTaskConversationsByActivity,
  recordConversationActivity as recordTaskConversationActivity,
} from "@/chat/task-execution/state";
import type { StateAdapter } from "chat";
import type { ConversationStore } from "./store";

/** Create the no-SQL conversation record store backed by task-execution state. */
export function createStateConversationStore(
  state?: StateAdapter,
): ConversationStore {
  return {
    get: (args) => getTaskConversation({ ...args, state }),
    recordActivity: (args) =>
      recordTaskConversationActivity({ ...args, state }),
    recordExecution: async () => {},
    listByActivity: (args) =>
      listTaskConversationsByActivity({ ...args, state }),
  };
}
