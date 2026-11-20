import type { HarnessRun } from "vitest-evals/harness";
import type { ConversationReportStatus } from "@/api/schema";
import type { GatewayProgress } from "./gateway";
import type { HistoryItem, HistoryReply, Input } from "./inputs";
import type { RecordedConversation } from "./recorded";
import type { Reply, ToolCall, Turn } from "./results";

export type TurnProgress =
  | GatewayProgress
  | { type: "reply"; text: string }
  /**
   * A turn stopped before it finished, for example at its deadline, and
   * Junior queued the rest of it. The rest waits until the handler finishes,
   * so a sent input arrives before the turn continues.
   */
  | { type: "paused" };

export interface CallOptions {
  /** Earlier turns as items, or a recorded conversation. */
  history?: HistoryItem[] | RecordedConversation;
  onProgress?:
    | ((
        progress: TurnProgress,
        actions: { send(input: Input): Promise<void> },
      ) => void | Promise<void>)
    | undefined;
}

/**
 * Returned by every call. The fields describe that call only. It is also the
 * vitest-evals run of the call, so `expect(conversation).toSatisfyJudge()`
 * takes it.
 */
export interface Conversation extends HarnessRun {
  conversationId: string;
  /** Assistant messages that people saw. */
  replies: Reply[];
  /** Tool calls of the agent, with their results. */
  toolCalls: ToolCall[];
  /** Slack reactions that Junior added. */
  reactions: string[];
  /** Names of the files that Junior uploaded to the Slack thread. */
  files: string[];
  /**
   * Status lines that Junior set under the Slack thread, in order. An empty
   * string clears the status.
   */
  statuses: string[];
  /** Titles that Junior gave the Slack thread, in order. */
  threadTitles: string[];
  /** The title that the dashboard shows after the call. */
  title: string;
  /** Whether the dashboard shows the Conversation as archived after the call. */
  archived: boolean;
  /** The status that the dashboard shows after the call. */
  status: ConversationReportStatus;
  /** Slack user ids of the participants that the dashboard lists after the call. */
  participantSlackUserIds: string[];
  /**
   * The label of the connect prompt that the dashboard shows to the person
   * after the call, when a turn waits for their authorization.
   */
  authorizationPrompt?: string;
  /** Times Junior replaced agent history with a summary, as the dashboard shows. */
  compactions: number;
  /** Text of each summary that the dashboard shows for those compactions. */
  compactionSummaries: string[];
  /** Ids of the active Watches that the dashboard lists after the call. */
  watchIds: string[];
  turns: Turn[];
  continue(
    input: Input | Input[],
    options?: CallOptions,
  ): Promise<Conversation>;
  fork(reply: Reply | HistoryReply): Promise<Conversation>;
  /**
   * Open a child Conversation of this one, such as a Thread that a spawnAgent
   * call started. Its `continue()` posts as the person who reads this one.
   */
  child(conversationId: string): Promise<Conversation>;
}

export type RunAgent = (
  input: Input | Input[],
  options?: CallOptions,
) => Promise<Conversation>;
