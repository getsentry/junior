import type { FileUpload } from "chat";
import type {
  WebSource,
  Destination,
  Identity,
  LocalDestination,
  LocalSource,
  PluginEgress,
  SlackDestination,
  SlackSource,
  Source,
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

interface HandoffControl {
  /** Non-empty catalog of configured targets. */
  profiles: readonly [ModelProfile, ...ModelProfile[]];
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
  conversationId?: string;

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
  slack?: never;
  slackActionToken?: never;
}

interface WebToolRuntimeContext extends BaseToolRuntimeContext {
  destination: Destination;
  actor?: WebActor;
  source: WebSource;
  slack?: never;
  slackActionToken?: never;
}

export type ToolRuntimeContext =
  | LocalToolRuntimeContext
  | SlackToolRuntimeContext
  | WebToolRuntimeContext;

export interface ToolState {
  getOperationResult: <T>(operationKey: string) => T | undefined;
  setOperationResult: (operationKey: string, result: unknown) => void;
}
