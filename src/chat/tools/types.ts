import type { FileUpload } from "chat";
import type { Sandbox } from "@vercel/sandbox";
import type { ThreadArtifactsState } from "@/chat/slack-actions/types";
import type { Skill } from "@/chat/skills";

export interface ToolHooks {
  onGeneratedFiles?: (files: FileUpload[]) => void;
  onArtifactStatePatch?: (patch: Partial<ThreadArtifactsState>) => void;
  onToolCallStart?: (toolName: string, input?: unknown) => void | Promise<void>;
  onToolCallEnd?: (toolName: string, input?: unknown) => void | Promise<void>;
  onSkillLoaded?: (skill: Skill) => void | Promise<void>;
}

export interface ToolRuntimeContext {
  channelId?: string;
  threadTs?: string;
  userText?: string;
  artifactState?: ThreadArtifactsState;
  configuration?: Record<string, unknown>;
  sandbox: Sandbox;
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
