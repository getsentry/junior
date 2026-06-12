import {
  appendInboundMessage,
  checkInConversationWork,
  clearExpiredConversationLease,
  completeConversationWork,
  drainConversationMailbox,
  getConversation,
  getConversationWorkState,
  listActiveConversationIds,
  listConversationsByActivity,
  markConversationMessagesInjected,
  markConversationWorkEnqueued,
  recordConversationActivity,
  removeActiveConversation,
  releaseConversationWork,
  requestConversationContinuation,
  requestConversationWork,
  startConversationWork,
} from "./state-task-execution-store";
import type { StateAdapter } from "chat";
import type { ConversationMetadataStore } from "./store";

/** Create the canonical metadata store backed by the current state adapter. */
export function createStateConversationMetadataStore(
  state?: StateAdapter,
): ConversationMetadataStore {
  return {
    getConversation: (args) => getConversation({ ...args, state }),
    getConversationWorkState: (args) =>
      getConversationWorkState({ ...args, state }),
    appendInboundMessage: (args) => appendInboundMessage({ ...args, state }),
    requestConversationWork: (args) =>
      requestConversationWork({ ...args, state }),
    recordConversationActivity: (args) =>
      recordConversationActivity({ ...args, state }),
    startConversationWork: (args) => startConversationWork({ ...args, state }),
    checkInConversationWork: (args) =>
      checkInConversationWork({ ...args, state }),
    drainConversationMailbox: (args) =>
      drainConversationMailbox({ ...args, state }),
    markConversationMessagesInjected: (args) =>
      markConversationMessagesInjected({ ...args, state }),
    markConversationWorkEnqueued: (args) =>
      markConversationWorkEnqueued({ ...args, state }),
    requestConversationContinuation: (args) =>
      requestConversationContinuation({ ...args, state }),
    releaseConversationWork: (args) =>
      releaseConversationWork({ ...args, state }),
    completeConversationWork: (args) =>
      completeConversationWork({ ...args, state }),
    clearExpiredConversationLease: (args) =>
      clearExpiredConversationLease({ ...args, state }),
    removeActiveConversation: (args) =>
      removeActiveConversation({ ...args, state }),
    listConversationsByActivity: (args) =>
      listConversationsByActivity({ ...args, state }),
    listActiveConversationIds: (args) =>
      listActiveConversationIds({ ...args, state }),
  };
}
