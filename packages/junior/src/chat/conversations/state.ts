import {
  getConversation,
  listConversationsByActivity,
  recordConversationActivity,
} from "@/chat/task-execution/state";
import type { StateAdapter } from "chat";
import type { ConversationStore } from "./store";

/** Create the no-SQL conversation record store backed by task-execution state. */
export function createStateConversationStore(
  state?: StateAdapter,
): ConversationStore {
  return {
    getConversation: (args) => getConversation({ ...args, state }),
    recordConversationActivity: (args) =>
      recordConversationActivity({ ...args, state }),
    recordConversationStatus: async () => {},
    listConversationsByActivity: (args) =>
      listConversationsByActivity({ ...args, state }),
  };
}
