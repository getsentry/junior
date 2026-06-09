import type { FileUpload } from "chat";
import type { Destination } from "@sentry/junior-plugin-api";
import type { McpToolManager } from "@/chat/mcp/tool-manager";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import type { ThreadArtifactsState } from "@/chat/state/artifacts";
import type { Skill } from "@/chat/skills";
import type { LoadSkillMetadata } from "@/chat/tools/skill/load-skill";
import type { AdvisorToolRuntimeContext } from "@/chat/tools/advisor/tool";
import type { Requester } from "@/chat/requester";

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

export interface ToolRuntimeContext {
  advisor?: AdvisorToolRuntimeContext;
  /**
   * Raw Slack channel/conversation container for this turn: `C...`, `D...`,
   * or `G...`. Never overridden by assistant context. Stable binding key for
   * state scoped to a Slack conversation. Passed to plugin hooks as-is via
   * `ToolRegistrationHookContext.channelId`.
   */
  channelId?: string;

  /**
   * Slack channel used by first-class delivery tools when assistant context
   * points at a source channel different from the raw conversation channel.
   */
  deliveryChannelId?: string;

  /**
   * Opaque Junior conversation/session identity for this turn.
   * Interactive Slack turns use `slack:{channelId}:{threadTs}`.
   * Scheduled/API turns use an internal id such as `agent-dispatch:{id}`.
   * Do not parse as Slack unless the value starts with `slack:`.
   */
  conversationId?: string;

  /** Runtime-owned destination for provider-neutral side effects. */
  destination?: Destination;

  requester?: Requester;
  teamId?: string;
  messageTs?: string;
  threadTs?: string;
  userText?: string;
  artifactState?: ThreadArtifactsState;
  configuration?: Record<string, unknown>;
  mcpToolManager?: McpToolManager;
  sandbox: SandboxWorkspace;
}

export interface ToolState {
  artifactState: ThreadArtifactsState;
  patchArtifactState: (
    patch: Partial<ThreadArtifactsState>,
  ) => void | Promise<void>;
  getCurrentListId: () => string | undefined;
  getOperationResult: <T>(operationKey: string) => T | undefined;
  setOperationResult: (operationKey: string, result: unknown) => void;
}
