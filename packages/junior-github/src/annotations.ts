import type {
  ConversationAnnotation,
  ConversationSidebarAnnotation,
} from "@sentry/junior-plugin-api";

const STATUS_RANK = {
  warning: 5,
  open: 4,
  draft: 3,
  merged: 2,
  closed: 1,
} as const;

const STATUS_ICON = {
  warning: "triangle-alert",
  open: "circle-dot",
  draft: "circle-dashed",
  merged: "git-merge",
  closed: "circle-x",
} as const;

type GitHubAnnotationStatus = keyof typeof STATUS_RANK;

function repositoryScope(
  annotation: ConversationAnnotation,
): { key: string; label: string } | undefined {
  try {
    const [, owner, repo] = new URL(annotation.url).pathname.split("/");
    return owner && repo ? { key: `${owner}/${repo}`, label: repo } : undefined;
  } catch {
    return undefined;
  }
}

function isPullRequestUrl(url: string): boolean {
  try {
    return /^\/[^/]+\/[^/]+\/pull\/\d+(?:\/|$)/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function sidebarIconForStatus(
  status: GitHubAnnotationStatus,
  links: Array<{ isPullRequest: boolean; status: GitHubAnnotationStatus }>,
): ConversationSidebarAnnotation["icon"] {
  if (
    status === "open" &&
    links.some((link) => link.status === "open" && link.isPullRequest)
  ) {
    return "git-pull-request";
  }
  return STATUS_ICON[status];
}

/** Select the one GitHub annotation summary shown in a conversation row. */
export function githubSidebarAnnotation(
  annotations: ConversationAnnotation[],
): ConversationSidebarAnnotation | undefined {
  const links = annotations.flatMap((annotation) => {
    const repo = repositoryScope(annotation);
    const status = annotation.status as GitHubAnnotationStatus | undefined;
    return repo && status
      ? [{ isPullRequest: isPullRequestUrl(annotation.url), repo, status }]
      : [];
  });
  if (links.length === 0) return undefined;
  const repos = new Map(links.map((link) => [link.repo.key, link.repo.label]));
  const status = links.reduce<GitHubAnnotationStatus>(
    (current, link) =>
      STATUS_RANK[link.status] > STATUS_RANK[current] ? link.status : current,
    "closed",
  );
  return {
    icon: sidebarIconForStatus(status, links),
    key: "github",
    label: repos.size === 1 ? [...repos.values()][0]! : `${repos.size} repos`,
  };
}
