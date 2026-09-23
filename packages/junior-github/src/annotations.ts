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
    const [, , repo] = new URL(annotation.url ?? "").pathname.split("/");
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
      return status && status in STATUS_ICON && label
        ? [
            {
              annotation: {
                icon: sidebarIconForStatus(status, annotation.url ?? ""),
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

import type {
  ObjectAnnotation,
  PluginAnnotations,
} from "@sentry/junior-plugin-api";

/** Describe a verified GitHub object without exposing Slack layout fields. */
export function githubObjectAnnotation(input: {
  repo: string;
  number: number;
  title: string;
  url: string;
  objectType: "task" | "code_change";
  status: string;
}): ObjectAnnotation {
  return {
    kind: "object",
    key: `${input.repo.toLowerCase()}#${input.number}`,
    label: `${input.repo}#${input.number}`,
    title: input.title.slice(0, 512),
    url: input.url,
    objectType: input.objectType,
    status: input.status,
  };
}

/** Refresh an existing object's status without selecting a card for delivery. */
export async function updateGitHubAnnotation(
  store: PluginAnnotations,
  input: {
    repo: string;
    number: number;
    objectType: "task" | "code_change";
    status: "merged" | "closed";
  },
): Promise<void> {
  const key = `${input.repo.toLowerCase()}#${input.number}`;
  const current = (await store.list()).find(
    (annotation) => annotation.key === key,
  );
  if (current?.kind === "object") {
    const {
      plugin: _plugin,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      ...annotation
    } = current;
    await store.upsert({ ...annotation, status: input.status });
    return;
  }
  await store.upsert({
    kind: "resource_link",
    key,
    label: `${input.repo}#${input.number}`,
    url: `https://github.com/${input.repo}/${input.objectType === "code_change" ? "pull" : "issues"}/${input.number}`,
    status: input.status,
  });
}
