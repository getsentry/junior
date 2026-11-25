/**
 * Give old GitHub Annotations the id of their object.
 *
 * Old rows name an issue or a pull request only by its repository name and
 * number, or by a link that a person attached. After a rename, search and
 * later updates do not find them. A heartbeat starts one bounded slice at a
 * time. Each slice reads a batch of these objects from GitHub, after the
 * cursor in plugin state, and saves each object's id and current link.
 * When GitHub names the object's repository with a new name, the
 * Annotations of the whole repository move to it.
 */
import pLimit from "p-limit";
import type {
  PluginStartedTaskDefinition,
  PluginState,
  PluginTaskStarter,
  UnnamedAnnotation,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { githubRepositoryMove } from "./annotations.js";
import { GITHUB_INBOX_SUBJECTS } from "./inbox-subjects.js";
import type {
  GitHubObjectName,
  GitHubObjectNameReader,
  GitHubObjectRef,
} from "./webhooks/installation-requests.js";

export const GITHUB_ANNOTATION_NAMES_TASK = "nameAnnotationObjects";

/** Objects that one slice reads. */
const BATCH = 50;

/**
 * The job's progress in plugin state: the key after which the next slice
 * reads, and the number of slices that ran, which names the next slice.
 */
const PROGRESS_KEY = "annotation-names:progress";
const progressSchema = z.object({
  after: z.string().optional(),
  done: z.boolean().optional(),
  slices: z.number().int().nonnegative(),
});
type Progress = z.output<typeof progressSchema>;

async function readProgress(state: PluginState): Promise<Progress> {
  return progressSchema.parse((await state.get(PROGRESS_KEY)) ?? { slices: 0 });
}

/** GitHub reads at once. */
const READ_CONCURRENCY = 4;

const payloadSchema = z.object({}).strict();

const OBJECT_KEY = /^([^/#\s]+)\/([^/#\s]+)#(\d+)$/;

// The issue or pull request of a GitHub link, such as
// `https://github.com/getsentry/junior/issues/12`.
function linkRef(url: string): GitHubObjectRef | undefined {
  const parsed = URL.parse(url);
  if (parsed?.protocol !== "https:" || parsed.hostname !== "github.com") {
    return undefined;
  }
  const [owner, name, collection, number] = parsed.pathname
    .split("/")
    .filter(Boolean);
  if (
    !owner ||
    !name ||
    (collection !== "issues" && collection !== "pull") ||
    !number ||
    !/^\d+$/.test(number)
  ) {
    return undefined;
  }
  return {
    kind: collection === "pull" ? "pull_request" : "issue",
    name,
    number: Number(number),
    owner,
  };
}

// The object of an Annotation, from its link, else from its key.
function objectRef(annotation: UnnamedAnnotation): GitHubObjectRef | undefined {
  const link = annotation.url ? linkRef(annotation.url) : undefined;
  if (link) return link;
  const key = OBJECT_KEY.exec(annotation.key);
  if (!key?.[1] || !key[2] || !key[3]) return undefined;
  return {
    kind: "issue",
    name: key[2],
    number: Number(key[3]),
    owner: key[1],
  };
}

// The full name of the repository in an object's link.
function repositoryOf(url: string): string | undefined {
  const link = linkRef(url);
  return link && `${link.owner}/${link.name}`;
}

/**
 * Start the next slice until one slice finds no more objects. The key
 * names the slice, so each slice starts once.
 */
export async function startGitHubAnnotationNames(args: {
  state: PluginState;
  tasks: PluginTaskStarter;
}): Promise<void> {
  const progress = await readProgress(args.state);
  if (progress.done) return;
  await args.tasks.start({
    key: `annotation-names:${progress.slices}`,
    name: GITHUB_ANNOTATION_NAMES_TASK,
    payload: {},
  });
}

/**
 * Save the id and the current link of each object in one batch. GitHub
 * does not find an object that is gone or that the App cannot read, so its
 * Annotations stay as they are, and the cursor moves past them. A failed
 * read fails the slice, so a later delivery reads it again. The last
 * delivery leaves that object as it is.
 */
export function githubAnnotationNamesTask(
  loadNames: () => Promise<GitHubObjectNameReader>,
): PluginStartedTaskDefinition<typeof payloadSchema> {
  return {
    payload: payloadSchema,
    async run(ctx) {
      const progress = await readProgress(ctx.state);
      if (progress.done) return;
      const batch = await ctx.annotations.listUnnamed({
        after: progress.after,
        limit: BATCH,
      });
      const moves = new Map<string, [from: string, to: string]>();
      const objects = batch.flatMap((annotation) => {
        const ref = objectRef(annotation);
        return ref ? [{ key: annotation.key, ref }] : [];
      });
      if (objects.length > 0) {
        const reader = await loadNames();
        const renames = new Map<string, Promise<string | undefined>>();
        // A repository that GitHub renamed answers by its old name too, and
        // an issue that moved to another repository answers by its old
        // link. So only the repository's own read tells a rename.
        const renamedTo = async (stored: string, current: string) => {
          if (stored.toLowerCase() === current.toLowerCase()) return undefined;
          const key = stored.toLowerCase();
          let read = renames.get(key);
          if (!read) {
            read = reader.readRepositoryName(stored);
            renames.set(key, read);
          }
          return (await read)?.toLowerCase() === current.toLowerCase()
            ? current
            : undefined;
        };
        await pLimit(READ_CONCURRENCY).map(objects, async ({ key, ref }) => {
          let name: GitHubObjectName | undefined;
          let renamed: string | undefined;
          const stored = `${ref.owner}/${ref.name}`;
          try {
            name = await reader.readObject(ref);
            const current = name && repositoryOf(name.url);
            renamed = current && (await renamedTo(stored, current));
          } catch (error) {
            if (!ctx.lastDelivery) throw error;
            ctx.log.error("GitHub Annotation object read failed", {}, error);
            return;
          }
          if (!name) return;
          await ctx.annotations.nameObject(key, {
            subject: {
              id: name.id,
              kind:
                name.kind === "pull_request"
                  ? GITHUB_INBOX_SUBJECTS.pullRequest
                  : GITHUB_INBOX_SUBJECTS.issue,
            },
            url: name.url,
          });
          if (renamed) moves.set(stored.toLowerCase(), [stored, renamed]);
        });
      }
      // A move changes keys of the batch and of later rows, so it runs after
      // the batch, and the next slice starts over. Each move names at least
      // one object, so this ends.
      for (const [from, to] of moves.values()) {
        // oxlint-disable-next-line no-await-in-loop -- Few repositories move, and each move is one write.
        await ctx.annotations.objectsMoved(githubRepositoryMove(from, to));
      }
      const slices = progress.slices + 1;
      const last = batch.at(-1);
      await ctx.state.set(
        PROGRESS_KEY,
        moves.size > 0
          ? { slices }
          : !last || batch.length < BATCH
            ? { done: true, slices }
            : { after: last.key, slices },
      );
    },
  };
}
