import type { FileUpload } from "chat";
import type {
  Destination,
  LocalDestination,
  LocalSource,
  PluginEgress,
  SlackDestination,
  SlackSource,
  Source,
} from "@sentry/junior-plugin-api";
import type { McpToolManager } from "@/chat/mcp/tool-manager";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import type { AgentTurnSurface } from "@/chat/state/turn-session";
import type { ThreadArtifactsState } from "@/chat/state/artifacts";
import type { Skill } from "@/chat/skills";
import type { LoadSkillMetadata } from "@/chat/tools/skill/load-skill";
import type { AdvisorToolRuntimeContext } from "@/chat/tools/advisor/tool";
import type {
  LocalRequester,
  Requester,
  SlackRequester,
} from "@/chat/requester";

export interface ImageGenerateToolDeps {
  fetch?: typeof fetch;
}

export interface WebFetchToolDeps {
  execute?: (input: {
    url: string;
    max_chars?: number;
  }) => Promise<unknown> | unknown;
}

export interface WebSearchToolDeps {
  execute?: (input: {
    query: string;
    max_results?: number;
  }) => Promise<unknown> | unknown;
}

/** Sandbox file handle returned to the model after a generated artifact is written. */
export interface GeneratedArtifactFileRef {
  bytes: number;
  filename: string;
  mimeType?: string;
  path: string;
}

export interface ToolHooks {
  /**
   * Materialize generated files and return sandbox paths that exist before the
   * generating tool reports success.
   */
  writeGeneratedArtifacts?: (
    files: FileUpload[],
  ) => GeneratedArtifactFileRef[] | Promise<GeneratedArtifactFileRef[]>;
  onGeneratedFiles?: (files: FileUpload[]) => void;
  onArtifactStatePatch?: (
    patch: Partial<ThreadArtifactsState>,
  ) => void | Promise<void>;
  onSkillLoaded?: (
    skill: Skill,
  ) => void | LoadSkillMetadata | Promise<void | LoadSkillMetadata>;
  toolOverrides?: {
    imageGenerate?: ImageGenerateToolDeps;
    webFetch?: WebFetchToolDeps;
    webSearch?: WebSearchToolDeps;
  };
}

interface BaseToolRuntimeContext {
  advisor?: AdvisorToolRuntimeContext;
  /**
   * Opaque Junior conversation/session identity for this turn.
   * Interactive Slack turns use `slack:{channelId}:{threadTs}`.
   * Scheduled/API turns use an internal id such as `agent-dispatch:{id}`.
   * Do not parse as Slack unless the value starts with `slack:`.
   */
  conversationId?: string;

  /** Runtime-owned default outbound destination for this invocation. */
  destination: Destination;

  requester?: Requester;
  /** Runtime-owned source where this invocation came from. */
  source: Source;
  /** Runtime surface that owns final delivery semantics for this turn. */
  surface?: AgentTurnSurface;
  userText?: string;
  artifactState?: ThreadArtifactsState;
  configuration?: Record<string, unknown>;
  egress: PluginEgress;
  mcpToolManager?: McpToolManager;
  sandbox: SandboxWorkspace;
}

interface SlackToolRuntimeContext extends BaseToolRuntimeContext {
  destination: SlackDestination;
  requester?: SlackRequester;
  source: SlackSource;
}

interface LocalToolRuntimeContext extends BaseToolRuntimeContext {
  destination: LocalDestination;
  requester?: LocalRequester;
  source: LocalSource;
  slack?: never;
}

export type ToolRuntimeContext =
  | LocalToolRuntimeContext
  | SlackToolRuntimeContext;

export interface ToolState {
  artifactState: ThreadArtifactsState;
  patchArtifactState: (
    patch: Partial<ThreadArtifactsState>,
  ) => void | Promise<void>;
  getCurrentListId: () => string | undefined;
  getOperationResult: <T>(operationKey: string) => T | undefined;
  setOperationResult: (operationKey: string, result: unknown) => void;
}
