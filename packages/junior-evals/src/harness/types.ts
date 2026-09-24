/**
 * Scenario, event, override, and result types shared by the eval harness.
 */
import { type Message } from "chat";
import { type JsonValue } from "vitest-evals/harness";
import type { EmittedLogRecord } from "@/chat/logging";
import { type ThreadMessageKind } from "@/chat/ingress/message-router";
import { type AgentTurnUsage } from "@/chat/usage";
import {
  FakeSlackAdapter,
  type TestThread,
} from "@junior-tests/fixtures/slack-harness";

interface NormalizedMessage {
  role: "system" | "user" | "assistant";
  content?: JsonValue;
  metadata?: Record<string, JsonValue>;
}

export interface EvalEventThreadFixture {
  channel_type?: "channel" | "group" | "im" | "mpim";
  channel_id?: string;
  id: string;
  run_id?: string;
  thread_ts?: string;
}

interface EvalEventMessageFixture {
  author?: {
    full_name?: string;
    is_bot?: boolean;
    is_me?: boolean;
    user_id?: string;
    user_name?: string;
  };
  id?: string;
  is_mention?: boolean;
  raw?: Record<string, unknown>;
  text?: string;
}

export interface EvalBaseEvent {
  thread: EvalEventThreadFixture;
}

export interface MentionEvent extends EvalBaseEvent {
  message: EvalEventMessageFixture;
  type: "new_mention";
}

export interface SubscribedMessageEvent extends EvalBaseEvent {
  message: EvalEventMessageFixture;
  type: "subscribed_message";
}

/** Models Slack messages that arrive while the preceding agent run is active. */
export interface SteerEvent {
  events: Array<MentionEvent | SubscribedMessageEvent>;
  type: "steer";
}

export interface AssistantThreadStartedEvent extends EvalBaseEvent {
  type: "assistant_thread_started";
  user_id?: string;
}

export interface AssistantContextChangedEvent extends EvalBaseEvent {
  type: "assistant_context_changed";
  user_id?: string;
}

export interface ScheduledAutomationDueEvent extends EvalBaseEvent {
  type: "scheduled_automation_due";
  credential_mode?: "creator" | "system";
  now_ms?: number;
  recurrence?: "daily" | "weekly" | "monthly" | "yearly";
  schedule?: string;
  schedule_kind?: "one_off" | "recurring";
  task_text: string;
  timezone?: string;
}

export interface EventAutomationMatchedEvent extends EvalBaseEvent {
  type: "event_automation_matched";
  event_key: string;
  event_type: string;
  label: string;
  namespace: string;
  identifier: string;
  resource_type: string;
  task_text: string;
  trusted_summary: string;
  untrusted_text?: string;
}

export interface EventFixture extends EvalBaseEvent {
  type: "event";
  data?: Record<string, unknown>;
  event_key: string;
  event_type: string;
  intent: string;
  label: string;
  namespace: string;
  identifier: string;
  resource_type: string;
  trusted_summary: string;
  untrusted_text?: string;
}

export interface GitHubWebhookEvent extends EvalBaseEvent {
  body: unknown;
  delivery_id: string;
  event_name: string;
  subscription: {
    events: string[];
    intent: string;
    label: string;
    identifier: string;
    resource_type: string;
  };
  type: "github_webhook";
}

export type EvalEvent =
  | MentionEvent
  | SubscribedMessageEvent
  | AssistantThreadStartedEvent
  | AssistantContextChangedEvent
  | ScheduledAutomationDueEvent
  | EventAutomationMatchedEvent
  | EventFixture
  | GitHubWebhookEvent;

type SlackMessageEvent = MentionEvent | SubscribedMessageEvent;

/** Return whether a scenario event is an inbound Slack message. */
export function isSlackMessageEvent(
  event: EvalEvent,
): event is SlackMessageEvent {
  return event.type === "new_mention" || event.type === "subscribed_message";
}

/** Events present before processing begins; multiple events form one Slack mailbox batch. */
export type InitialEvents =
  | []
  | [EvalEvent]
  | [SlackMessageEvent, SlackMessageEvent, ...SlackMessageEvent[]];

/** Flatten scenario events, expanding steer() groups, in delivery order. */
export function scenarioEvents(scenario: EvalScenario): EvalEvent[] {
  return [
    ...scenario.initialEvents,
    ...(scenario.events ?? []).flatMap((event) =>
      event.type === "steer" ? event.events : [event],
    ),
  ];
}

/** Host image fixture exposed at one model-visible sandbox path. */
interface EvalViewImageFixture {
  path: string;
  source: string;
}

export interface EvalOverrides {
  active_turn_compaction?: {
    summary: string;
  };
  auto_complete_mcp_oauth?: string[];
  auto_complete_oauth?: string[];
  credential_providers?: Array<"github" | "sentry">;
  expired_oauth_tokens?: string[];
  github_events?: boolean;
  mock_image_generation?: boolean;
  plugin_dirs?: string[];
  plugin_packages?: string[];
  reply_timeout_ms?: number;
  reply_texts?: string[];
  skill_dirs?: string[];
  /** Agent turn deadline for every run slice, in ms. Must stay under the reply budget. */
  turn_timeout_ms?: number;
  view_image_files?: EvalViewImageFixture[];
}

export interface EvalScenario {
  initialEvents: InitialEvents;
  events?: Array<EvalEvent | SteerEvent>;
  overrides?: EvalOverrides;
}

export interface EvalScenarioRunOptions {
  logRecords?: EmittedLogRecord[];
  signal?: AbortSignal;
}

export interface SteeringDelivery {
  deliver?: () => Promise<void>;
}

export interface EvalResult {
  sessionMessages: NormalizedMessage[];
  canvases: EvalCanvasArtifact[];
  channelPosts: Array<{
    channel: string;
    text: string;
    thread_ts?: string;
  }>;
  /**
   * Runtime conversation ids that took a turn in this scenario. These are the
   * exact ids the durable SQL stores key on, so eval-layer assertions can read
   * history/messages back through the store ports for the same conversation.
   */
  conversationIds: string[];
  logRecords: EmittedLogRecord[];
  authorizationCompletions: AuthorizationCompletion[];
  posts: EvalAssistantPost[];
  reactions: Array<{
    channel: string;
    emoji: string;
    timestamp: string;
  }>;
  modelIds: string[];
  slackAdapter: FakeSlackAdapter;
  toolInvocations: EvalToolInvocation[];
  usage?: AgentTurnUsage;
}

export interface AuthorizationCompletion {
  credentialStored: true;
  delivery: "direct_message" | "ephemeral";
  kind: "mcp" | "plugin";
  provider: string;
  userId: string;
}

export interface EvalAttachedFile {
  filename: string;
  isImage: boolean;
  mimeType?: string;
  sizeBytes?: number;
}

export interface EvalAssistantPost {
  channel?: string;
  eventType?: "channel_post" | "thread_post";
  files: EvalAttachedFile[];
  text: string;
  thread_ts?: string;
}

export interface EvalCanvasArtifact {
  markdown: string;
  title: string;
}

export interface EvalToolInvocation {
  arguments?: Record<string, unknown>;
  tool: string;
  toolCallId?: string;
  bash_command?: string;
  completed?: boolean;
  error?: string;
  mcp_arguments?: Record<string, unknown>;
  mcp_tool_name?: string;
  ok?: boolean;
  result?: unknown;
  skill_name?: string;
}

export interface EvalSlackThreadReply {
  bot_id?: string;
  text?: string;
  thread_ts?: string;
  ts?: string;
  user?: string;
}

export interface EvalThreadRecord {
  thread: TestThread;
  transcript: Message[];
  recordedPosts: number;
}

export interface QueueDelivery {
  kind: ThreadMessageKind;
  message: Message;
  thread: TestThread;
}

export interface RuntimeObservations {
  errors: unknown[];
  authorizationCompletions: AuthorizationCompletion[];
  modelIds: Set<string>;
  sessionMessages: NormalizedMessage[];
  toolInvocations: EvalToolInvocation[];
  usage?: AgentTurnUsage;
}
