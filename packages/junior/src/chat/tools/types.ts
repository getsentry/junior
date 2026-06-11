import type { FileUpload } from "chat";
import type {
  Destination,
  LocalDestination,
  SlackDestination,
} from "@sentry/junior-plugin-api";
import type { McpToolManager } from "@/chat/mcp/tool-manager";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
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

export interface ToolHooks {
  getGeneratedFile?: (filename: string) => FileUpload | undefined;
  onGeneratedArtifactFiles?: (files: FileUpload[]) => void;
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

  /** Runtime-owned destination for provider-neutral side effects. */
  destination: Destination;

  requester?: Requester;
  userText?: string;
  artifactState?: ThreadArtifactsState;
  configuration?: Record<string, unknown>;
  mcpToolManager?: McpToolManager;
  sandbox: SandboxWorkspace;
}

interface SlackToolRuntimeHints {
  /**
   * Slack delivery override when assistant context points at a source channel
   * different from the raw destination channel.
   */
  deliveryChannelId?: string;
  /** Current inbound Slack message timestamp for reaction tools. */
  messageTs?: string;
  /** Current inbound Slack thread timestamp for hook context. */
  threadTs?: string;
}

interface SlackToolRuntimeContext extends BaseToolRuntimeContext {
  destination: SlackDestination;
  requester?: SlackRequester;
  slack?: SlackToolRuntimeHints;
}

interface LocalToolRuntimeContext extends BaseToolRuntimeContext {
  destination: LocalDestination;
  requester?: LocalRequester;
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
