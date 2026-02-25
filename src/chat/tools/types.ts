import type { FileUpload } from "chat";
import type { ThreadArtifactsState } from "@/chat/slack-actions/types";

export interface ToolHooks {
  onGeneratedFiles?: (files: FileUpload[]) => void;
  onArtifactStatePatch?: (patch: Partial<ThreadArtifactsState>) => void;
}

export interface ToolRuntimeContext {
  channelId?: string;
  threadTs?: string;
  artifactState?: ThreadArtifactsState;
}

export interface ToolState {
  artifactState: ThreadArtifactsState;
  patchArtifactState: (patch: Partial<ThreadArtifactsState>) => void;
  getCurrentCanvasId: () => string | undefined;
  getCurrentListId: () => string | undefined;
}
