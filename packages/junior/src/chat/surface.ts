export type AssistantSurfacePlatform = "slack" | "github";
export type AssistantSurfaceOutputFormat = "slack-mrkdwn" | "github-gfm";
export type AssistantSurfaceToolProfile = "slack" | "github-comment";

export interface AssistantSurface {
  outputFormat: AssistantSurfaceOutputFormat;
  platform: AssistantSurfacePlatform;
  toolProfile: AssistantSurfaceToolProfile;
}

export const SLACK_SURFACE: AssistantSurface = {
  platform: "slack",
  outputFormat: "slack-mrkdwn",
  toolProfile: "slack",
};

export const GITHUB_COMMENT_SURFACE: AssistantSurface = {
  platform: "github",
  outputFormat: "github-gfm",
  toolProfile: "github-comment",
};
