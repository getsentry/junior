import type {
  ConversationAnnotation,
  ConversationSidebarAnnotation,
  ObjectAnnotation,
} from "@sentry/junior-plugin-api";
import { GITHUB_INBOX_SUBJECTS } from "./inbox-subjects.js";

function githubObjectType(
  annotation: ConversationAnnotation,
): "task" | "code_change" {
  if (
    annotation.objectType === "task" ||
    annotation.objectType === "code_change"
  ) {
    return annotation.objectType;
  }
  // Older resource links have no type. Only the provider interprets its URLs.
  return annotation.url &&
    /^\/[^/]+\/[^/]+\/pull\/\d+(?:\/|$)/.test(new URL(annotation.url).pathname)
    ? "code_change"
    : "task";
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
      const label = repositoryName(annotation);
      if (!label) return [];
      const sidebar: ConversationSidebarAnnotation = {
        objectType: githubObjectType(annotation),
        status: annotation.status,
        key: annotation.key,
        label,
      };
      if (annotation.kind === "object") {
        sidebar.title = annotation.title;
        if (annotation.facts?.type === "code_change") {
          const image = annotation.facts.previewImageUrls?.[0];
          if (image) sidebar.imageUrl = image;
        }
      }
      if (annotation.url) sidebar.url = annotation.url;
      return [{ annotation: sidebar, updatedAt: annotation.updatedAt }];
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map(({ annotation }) => annotation);
}

/** Return the Annotation key of a GitHub issue or pull request. */
export function githubObjectKey(repo: string, number: number): string {
  return `${repo.toLowerCase()}#${number}`;
}

/** Build the annotation returned by GitHub create and update tools. */
export function githubObjectAnnotation(input: {
  repo: string;
  number: number;
  /**
   * GitHub's id of the issue or pull request (`databaseId`), which a
   * rename keeps. It names the object with the kind of its Inbox items.
   */
  id?: string | undefined;
  title: string;
  url: string;
  objectType: "task" | "code_change";
  status: string;
  facts?: ObjectAnnotation["facts"] | undefined;
  sourceUpdatedAt?: string | undefined;
  description?: string | undefined;
}): ObjectAnnotation {
  return {
    kind: "object",
    key: githubObjectKey(input.repo, input.number),
    ...(input.id
      ? {
          subject: {
            id: input.id,
            kind:
              input.objectType === "code_change"
                ? GITHUB_INBOX_SUBJECTS.pullRequest
                : GITHUB_INBOX_SUBJECTS.issue,
          },
        }
      : undefined),
    label: `${input.repo}#${input.number}`,
    title: input.title.slice(0, 512),
    url: input.url,
    objectType: input.objectType,
    status: input.status,
    displayType: input.objectType === "code_change" ? "Pull request" : "Issue",
    facts: input.facts,
    description: input.description,
    sourceUpdatedAt: input.sourceUpdatedAt,
  };
}
