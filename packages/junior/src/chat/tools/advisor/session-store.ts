import type { PiMessage } from "@/chat/pi/messages";
import { getStateAdapter } from "@/chat/state/adapter";
import { JUNIOR_THREAD_STATE_TTL_MS } from "@/chat/state/ttl";

const ADVISOR_SESSION_TTL_MS = JUNIOR_THREAD_STATE_TTL_MS;

export interface AdvisorSessionStore {
  load: (conversationId: string) => Promise<PiMessage[]>;
  save: (conversationId: string, messages: PiMessage[]) => Promise<void>;
}

function cloneMessages(messages: PiMessage[]): PiMessage[] {
  return structuredClone(messages);
}

/** Return the durable advisor session key for an opaque parent conversation id. */
export function getAdvisorSessionKey(conversationId: string): string {
  return `junior:${conversationId}:advisor_session`;
}

/** Create the production advisor message store backed by the chat state adapter. */
export function createStateAdvisorSessionStore(): AdvisorSessionStore {
  return {
    load: async (conversationId) => {
      const stateAdapter = getStateAdapter();
      await stateAdapter.connect();
      const messages =
        (await stateAdapter.get<PiMessage[]>(
          getAdvisorSessionKey(conversationId),
        )) ?? [];
      return cloneMessages(messages);
    },
    save: async (conversationId, messages) => {
      const stateAdapter = getStateAdapter();
      await stateAdapter.connect();
      await stateAdapter.set(
        getAdvisorSessionKey(conversationId),
        cloneMessages(messages),
        ADVISOR_SESSION_TTL_MS,
      );
    },
  };
}
