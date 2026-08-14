import type {
  ConversationAnnotation,
  ConversationSidebarAnnotation,
} from "@sentry/junior-plugin-api";

const STATUS_ICON = {
  warning: "triangle-alert",
  open: "circle-dot",
  draft: "circle-dashed",
  merged: "git-merge",
  closed: "circle-x",
} as const;

type GitHubAnnotationStatus = keyof typeof STATUS_ICON;

function isPullRequestUrl(url: string): boolean {
  try {
    return /^\/[^/]+\/[^/]+\/pull\/\d+(?:\/|$)/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function sidebarIconForStatus(
  status: GitHubAnnotationStatus,
  url: string,
): ConversationSidebarAnnotation["icon"] {
  if (status === "open" && isPullRequestUrl(url)) return "git-pull-request";
  return STATUS_ICON[status];
}

function repositoryName(
  annotation: ConversationAnnotation,
): string | undefined {
  try {
    const [, , repo] = new URL(annotation.url).pathname.split("/");
    return repo || undefined;
  } catch {
    return undefined;
  }
}

/** Return GitHub annotations for a conversation row, newest first. */
export function githubSidebarAnnotations(
  annotations: ConversationAnnotation[],
): ConversationSidebarAnnotation[] {
  return annotations
    .flatMap((annotation) => {
      const status = annotation.status as GitHubAnnotationStatus | undefined;
      const label = repositoryName(annotation);
      return status && label
        ? [
            {
              annotation: {
                icon: sidebarIconForStatus(status, annotation.url),
                key: annotation.key,
                label,
              },
              updatedAt: annotation.updatedAt,
            },
          ]
        : [];
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map(({ annotation }) => annotation);
}
