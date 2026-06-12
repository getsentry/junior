import {
  getConversation,
  listConversationsByActivity,
  recordConversationActivity,
} from "@/chat/task-execution/state";
import type { StateAdapter } from "chat";
import type { ConversationStore } from "./store";

/** Create a local conversation feed backed by the current state adapter. */
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
