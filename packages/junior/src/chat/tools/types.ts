import type { FileUpload } from "chat";
import type {
  AgentInvocationSource,
  EventTaskSource,
  WebSource,
  ResourceEventSource,
  Destination,
  Identity,
  Location,
  LocalDestination,
  LocalSource,
  PluginDispatchSource,
  PluginEgress,
  SlackDestination,
  SlackSource,
  Source,
  ScheduledTaskSource,
  User,
} from "@sentry/junior-plugin-api";
import type { McpToolManager } from "@/chat/mcp/tool-manager";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import type { AgentTurnSurface } from "@/chat/task-execution/checkpoint";
import type { Skill } from "@/chat/skills";
import type { JuniorToolOutput } from "@/chat/tool-support/structured-result";
import type { WebActor, LocalActor, Actor, SlackActor } from "@/chat/actor";
import type { SlackActionToken } from "@/chat/slack/action-token";
import type { ModelProfile } from "@/chat/model-profile";
import type { GeneratedArtifactFileRef } from "@/chat/tools/sandbox/file-uploads";
import type { SpawnAgent } from "@/chat/agent/types";
import type { AttachmentStorage } from "@/chat/attachments/storage";
import type { Workspace } from "@/chat/workspaces/types";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";

interface HandoffControl {
  /** Non-empty catalog of configured targets. */
  profiles: readonly [ModelProfile, ...ModelProfile[]];
  /** Optional host-owned descriptions keyed by profile name. */
  profileDescriptions?: Readonly<Partial<Record<ModelProfile, string>>>;
  execute: (
    profile: ModelProfile,
    options: { signal?: AbortSignal; toolCallId: string },
  ) => Promise<void>;
}

export interface ImageGenerateToolDeps {
  fetch?: typeof fetch;
}

export interface WebFetchToolDeps {
  execute?: (input: {
    url: string;
    max_chars?: number;
  }) => Promise<JuniorToolOutput> | JuniorToolOutput;
}

export interface WebSearchToolDeps {
  execute?: (input: {
    query: string;
    max_results?: number;
  }) => Promise<JuniorToolOutput> | JuniorToolOutput;
}

/** Optional host image reader for deterministic tool execution without sandbox I/O. */
export interface ViewImageToolDeps {
  readFile?: (path: string) => Promise<Buffer | null | undefined>;
}

export interface ToolHooks {
  /**
   * Materialize generated files and return sandbox paths that exist before the
   * generating tool reports success.
   */
  writeGeneratedArtifacts?: (
    files: FileUpload[],
  ) => GeneratedArtifactFileRef[] | Promise<GeneratedArtifactFileRef[]>;
  onSkillLoaded?: (skill: Skill) => void | Promise<void>;
  toolOverrides?: {
    imageGenerate?: ImageGenerateToolDeps;
    viewImage?: ViewImageToolDeps;
    webFetch?: WebFetchToolDeps;
    webSearch?: WebSearchToolDeps;
  };
}

interface BaseToolRuntimeContext {
  attachmentStorage?: AttachmentStorage;
  handoff?: HandoffControl;
  spawnAgent?: SpawnAgent;
  /**
   * Opaque Junior conversation/session identity for this turn.
   * Interactive Slack turns use `slack:{channelId}:{threadTs}`.
   * Scheduled/web turns use an internal id such as `agent-dispatch:{id}`.
   * Do not parse as Slack unless the value starts with `slack:`.
   */
  conversationId: string;
  /** Location associated with this Conversation. */
  location?: Location;
  // TODO(dcramer): Remove locationId after memory and plugin contexts read
  // Location directly.
  /** Legacy Location identity used by memory and plugin contexts. */
  locationId?: string;
  /** Stored Conversation visibility used by tools. */
  conversationPrivacy?: ConversationPrivacy;

  /** Runtime-owned default outbound destination for this invocation. */
  destination: Destination;

  actor?: Actor;
  resolveActorIdentity?: () => Promise<
    { identity: Identity; user?: User } | undefined
  >;
  /** Runtime-owned source where this invocation came from. */
  source: Source;
  /** Runtime surface that owns final delivery semantics for this turn. */
  surface?: AgentTurnSurface;
  userText?: string;
  configuration?: Record<string, unknown>;
  egress: PluginEgress;
  mcpToolManager?: McpToolManager;
  workspace: SandboxWorkspace;
  workspaces?: {
    activeWorkspaceId(): string | undefined;
    switch(workspace: Workspace, signal?: AbortSignal): Promise<void>;
  };
  /** Report whether the model currently executing the turn accepts images. */
  supportsImageInput?: () => boolean;
}

interface SlackToolRuntimeContext extends BaseToolRuntimeContext {
  destination: SlackDestination;
  actor?: SlackActor;
  source: SlackSource;
  slackActionToken?: SlackActionToken;
}

interface LocalToolRuntimeContext extends BaseToolRuntimeContext {
  destination: LocalDestination;
  actor?: LocalActor;
  source: LocalSource;
  slackActionToken?: never;
}

interface WebToolRuntimeContext extends BaseToolRuntimeContext {
  destination: Destination;
  actor?: WebActor;
  source: WebSource;
  slackActionToken?: never;
}

export type ToolRuntimeContext =
  | LocalToolRuntimeContext
  | SlackToolRuntimeContext
  | WebToolRuntimeContext
  | (BaseToolRuntimeContext & {
      destination: Destination;
      actor?: Actor;
      source:
        | AgentInvocationSource
        | EventTaskSource
        | PluginDispatchSource
        | ResourceEventSource
        | ScheduledTaskSource;
      slackActionToken?: never;
    });

export interface ToolState {
  getOperationResult: <T>(operationKey: string) => T | undefined;
  setOperationResult: (operationKey: string, result: unknown) => void;
}
