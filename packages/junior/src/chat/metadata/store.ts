import type {
  AppendInboundMessageResult,
  Conversation,
  ConversationWorkState,
  InboundMessage,
  RequestConversationWorkResult,
  StartConversationWorkResult,
} from "./state-task-execution-store";
import type { Destination } from "@sentry/junior-plugin-api";
import type { StoredSlackRequester } from "@/chat/requester";

export interface ConversationMetadataStore {
  getConversation(args: {
    conversationId: string;
  }): Promise<Conversation | undefined>;
  getConversationWorkState(args: {
    conversationId: string;
  }): Promise<ConversationWorkState | undefined>;
  appendInboundMessage(args: {
    message: InboundMessage;
    nowMs?: number;
  }): Promise<AppendInboundMessageResult>;
  requestConversationWork(args: {
    conversationId: string;
    destination: Destination;
    nowMs?: number;
  }): Promise<RequestConversationWorkResult>;
  recordConversationActivity(args: {
    activityAtMs?: number;
    channelName?: string;
    conversationId: string;
    destination?: Destination;
    nowMs?: number;
    requester?: StoredSlackRequester;
    source?: Conversation["source"];
    title?: string;
  }): Promise<void>;
  startConversationWork(args: {
    conversationId: string;
    nowMs?: number;
  }): Promise<StartConversationWorkResult>;
  checkInConversationWork(args: {
    conversationId: string;
    leaseToken: string;
    nowMs?: number;
  }): Promise<boolean>;
  drainConversationMailbox(args: {
    conversationId: string;
    inject: (messages: InboundMessage[]) => Promise<void>;
    leaseToken: string;
    nowMs?: number;
  }): Promise<InboundMessage[]>;
  markConversationMessagesInjected(args: {
    conversationId: string;
    inboundMessageIds: string[];
    leaseToken: string;
    nowMs?: number;
  }): Promise<boolean>;
  markConversationWorkEnqueued(args: {
    conversationId: string;
    nowMs?: number;
  }): Promise<void>;
  requestConversationContinuation(args: {
    conversationId: string;
    destination: Destination;
    leaseToken: string;
    nowMs?: number;
  }): Promise<boolean>;
  releaseConversationWork(args: {
    conversationId: string;
    leaseToken: string;
    nowMs?: number;
  }): Promise<boolean>;
  completeConversationWork(args: {
    conversationId: string;
    leaseToken: string;
    nowMs?: number;
  }): Promise<"completed" | "lost_lease" | "pending">;
  clearExpiredConversationLease(args: {
    conversationId: string;
    nowMs?: number;
  }): Promise<boolean>;
  removeActiveConversation(args: { conversationId: string }): Promise<void>;
  listConversationsByActivity(args?: {
    limit?: number;
    offset?: number;
  }): Promise<Conversation[]>;
  listActiveConversationIds(args?: {
    limit?: number;
    staleBeforeMs?: number;
  }): Promise<string[]>;
}
