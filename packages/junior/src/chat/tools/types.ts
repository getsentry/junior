import type { FileUpload } from "chat";
import type { McpToolManager } from "@/chat/mcp/tool-manager";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import type { ThreadArtifactsState } from "@/chat/slack-actions/types";
import type { Skill } from "@/chat/skills";
import type { LoadSkillMetadata } from "@/chat/tools/load-skill";

export interface ImageGenerateToolDeps {
  fetch?: typeof fetch;
}

export interface ToolHooks {
  getGeneratedFile?: (filename: string) => FileUpload | undefined;
  onGeneratedArtifactFiles?: (files: FileUpload[]) => void;
  onGeneratedFiles?: (files: FileUpload[]) => void;
  onArtifactStatePatch?: (patch: Partial<ThreadArtifactsState>) => void;
  onToolCallStart?: (toolName: string, input?: unknown) => void | Promise<void>;
  onToolCallEnd?: (toolName: string, input?: unknown) => void | Promise<void>;
  onSkillLoaded?: (
    skill: Skill,
  ) => void | LoadSkillMetadata | Promise<void | LoadSkillMetadata>;
  toolOverrides?: {
    imageGenerate?: ImageGenerateToolDeps;
  };
}

export interface ToolRuntimeContext {
  channelId?: string;
  messageTs?: string;
  threadTs?: string;
  userText?: string;
  artifactState?: ThreadArtifactsState;
  configuration?: Record<string, unknown>;
  getActiveSkills?: () => Skill[];
  mcpToolManager?: McpToolManager;
  sandbox: SandboxWorkspace;
}

export interface ToolState {
  artifactState: ThreadArtifactsState;
  patchArtifactState: (patch: Partial<ThreadArtifactsState>) => void;
  getCurrentCanvasId: () => string | undefined;
  getTurnCreatedCanvasId: () => string | undefined;
  setTurnCreatedCanvasId: (canvasId: string) => void;
  getCurrentListId: () => string | undefined;
  getOperationResult: <T>(operationKey: string) => T | undefined;
  setOperationResult: (operationKey: string, result: unknown) => void;
}
