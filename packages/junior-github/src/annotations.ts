import pLimit from "p-limit";
import {
  objectFactsMatchType,
  type ConversationAnnotation,
  type ConversationAnnotationChange,
  type ConversationAnnotationInput,
  type ConversationSidebarAnnotation,
  type ObjectAnnotation,
  type PluginAnnotations,
  type PluginConversationAnnotations,
  type PluginLogger,
} from "@sentry/junior-plugin-api";

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
          const { additions, changedFiles, deletions, previewImageUrls } =
            annotation.facts;
          const image = previewImageUrls?.[0];
          if (image) sidebar.imageUrl = image;
          if (
            additions !== undefined ||
            deletions !== undefined ||
            changedFiles !== undefined
          ) {
            sidebar.size = { additions, changedFiles, deletions };
          }
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

interface GitHubStatusUpdate {
  repo: string;
  number: number;
  objectType: "task" | "code_change";
  status: "merged" | "closed";
}

/**
 * Return the annotation that shows a new status of one object, from the
 * stored annotations of a conversation. It keeps a saved object card and
 * does not select a card for delivery.
 */
function githubStatusAnnotation(
  annotations: ConversationAnnotation[],
  input: GitHubStatusUpdate,
): ConversationAnnotationInput {
  const key = githubObjectKey(input.repo, input.number);
  const current = annotations.find((annotation) => annotation.key === key);
  if (current?.kind === "object") {
    const {
      plugin: _plugin,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      facts,
      ...annotation
    } = current;
    return {
      ...annotation,
      // Facts saved for another object type are not valid for this one.
      ...(facts && objectFactsMatchType(facts, input.objectType)
        ? { facts }
        : undefined),
      objectType: input.objectType,
      status: input.status,
    };
  }
  return {
    kind: "resource_link",
    objectType: input.objectType,
    key,
    label: `${input.repo}#${input.number}`,
    url: `https://github.com/${input.repo}/${input.objectType === "code_change" ? "pull" : "issues"}/${input.number}`,
    status: input.status,
  };
}

/** Refresh an existing object's status without selecting a card for delivery. */
async function updateGitHubAnnotation(
  store: PluginAnnotations,
  input: GitHubStatusUpdate,
): Promise<void> {
  await store.upsert(githubStatusAnnotation(await store.list(), input));
}

/** Conversations whose annotation one update changes at once. */
export const ANNOTATION_UPDATE_CONCURRENCY = 8;

/**
 * Refresh the status of one object in each linked conversation. One failed
 * conversation does not stop the others. Each failure is logged.
 */
export async function updateGitHubAnnotations(args: {
  annotations: PluginConversationAnnotations;
  conversationIds: string[];
  log?: Pick<PluginLogger, "error"> | undefined;
  update: GitHubStatusUpdate;
}): Promise<void> {
  const limit = pLimit(ANNOTATION_UPDATE_CONCURRENCY);
  const results = await Promise.allSettled(
    args.conversationIds.map((conversationId) =>
      limit(() =>
        updateGitHubAnnotation(
          args.annotations.forConversation(conversationId),
          args.update,
        ),
      ),
    ),
  );
  for (const result of results) {
    if (result.status === "fulfilled") continue;
    args.log?.error("GitHub conversation annotation update failed", {
      errorType:
        result.reason instanceof Error ? result.reason.name : "UnknownError",
      number: args.update.number,
      objectType: args.update.objectType,
      repository: args.update.repo,
    });
  }
}

/**
 * Return the status change of one object for each linked conversation, to
 * save in one batch with other changes.
 */
export async function githubAnnotationChanges(args: {
  annotations: PluginConversationAnnotations;
  conversationIds: string[];
  update: GitHubStatusUpdate;
}): Promise<ConversationAnnotationChange[]> {
  return await pLimit(ANNOTATION_UPDATE_CONCURRENCY).map(
    args.conversationIds,
    async (conversationId) => ({
      conversationId,
      upsert: githubStatusAnnotation(
        await args.annotations.forConversation(conversationId).list(),
        args.update,
      ),
    }),
  );
}
