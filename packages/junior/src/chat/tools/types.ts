import type { FileUpload } from "chat";
import type { McpToolManager } from "@/chat/mcp/tool-manager";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import type { ThreadArtifactsState } from "@/chat/state/artifacts";
import type { Skill } from "@/chat/skills";
import type { LoadSkillMetadata } from "@/chat/tools/skill/load-skill";
import type { ChannelCapabilities } from "@/chat/tools/channel-capabilities";
import type { AdvisorToolRuntimeContext } from "@/chat/tools/advisor/tool";

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
  channelId?: string;
  channelCapabilities: ChannelCapabilities;
  requester?: {
    userId?: string;
    userName?: string;
    fullName?: string;
  };
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
