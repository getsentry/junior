import type { FileUpload } from "chat";
import type { Sandbox } from "@vercel/sandbox";
import type { ThreadArtifactsState } from "@/chat/slack-actions/types";

export interface ToolHooks {
  onGeneratedFiles?: (files: FileUpload[]) => void;
  onArtifactStatePatch?: (patch: Partial<ThreadArtifactsState>) => void;
  onToolCallStart?: (toolName: string) => void | Promise<void>;
  onToolCallEnd?: (toolName: string) => void | Promise<void>;
}

export interface ToolRuntimeContext {
  channelId?: string;
  threadTs?: string;
  artifactState?: ThreadArtifactsState;
  sandbox?: Sandbox;
}

export interface ToolState {
  artifactState: ThreadArtifactsState;
  patchArtifactState: (patch: Partial<ThreadArtifactsState>) => void;
  getCurrentCanvasId: () => string | undefined;
  getCurrentListId: () => string | undefined;
  getOperationResult: <T>(operationKey: string) => T | undefined;
  setOperationResult: (operationKey: string, result: unknown) => void;
}
