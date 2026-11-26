/**
 * Give old GitHub Annotations the id of their object, and the current name
 * of their repository.
 *
 * Old rows name an issue or a pull request only by its repository name and
 * number, or by a link that a person attached. After a rename, search and
 * later updates do not find them. A heartbeat starts one bounded slice at a
 * time, after the cursor in plugin state. The job first reads each object
 * whose Annotations have its id once, so a rename from before this release
 * moves them. Then it reads each object whose Annotations have no id, and
 * saves its id and current link. When GitHub names an object's repository
 * with a new name, the Annotations of the whole repository move to it.
 */
import pLimit from "p-limit";
import type {
  PluginStartedTaskDefinition,
  PluginState,
  PluginTaskStarter,
  ListedAnnotation,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { githubRepositoryMove, orderRepositoryRenames } from "./annotations.js";
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
 * The job's progress in plugin state: the pass, the key after which the
 * next slice reads in it, and the number of slices that ran, which names
 * the next slice. The `named` pass reads the objects that have their id,
 * then the `unnamed` pass reads the others.
 */
const PROGRESS_KEY = "annotation-names:progress";
const progressSchema = z.object({
  after: z.string().optional(),
  done: z.boolean().optional(),
  pass: z.enum(["named", "unnamed"]).default("named"),
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
function objectRef(annotation: ListedAnnotation): GitHubObjectRef | undefined {
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
 * Read at most one batch of objects, in the current pass and then in the
 * next one. GitHub does not find an object that is gone or that the App
 * cannot read, so its Annotations stay as they are, and the cursor moves
 * past them. A failed read fails the slice, so a later delivery reads it
 * again. The last delivery leaves that object as it is.
 */
export function githubAnnotationNamesTask(
  loadNames: () => Promise<GitHubObjectNameReader>,
): PluginStartedTaskDefinition<typeof payloadSchema> {
  return {
    payload: payloadSchema,
    async run(ctx) {
      const start = await readProgress(ctx.state);
      if (start.done) return;
      let progress = start;
      let budget = BATCH;
      let reader: GitHubObjectNameReader | undefined;
      const renames = new Map<string, Promise<string | undefined>>();
      // A repository that GitHub renamed answers by its old name too, and
      // an issue that moved to another repository answers by its old link.
      // So only the repository's own read tells a rename.
      const renamedTo = async (
        names: GitHubObjectNameReader,
        stored: string,
        current: string,
      ) => {
        if (stored.toLowerCase() === current.toLowerCase()) return undefined;
        const key = stored.toLowerCase();
        let read = renames.get(key);
        if (!read) {
          read = names.readRepositoryName(stored);
          renames.set(key, read);
        }
        return (await read)?.toLowerCase() === current.toLowerCase()
          ? current
          : undefined;
      };
      // A failed read fails the slice only after the moves it found, since
      // the objects that named them are no longer listed on a retry.
      let failure: unknown;
      while (!progress.done && budget > 0 && failure === undefined) {
        const named = progress.pass === "named";
        const limit = budget;
        // oxlint-disable-next-line no-await-in-loop -- A slice reads a pass at a time, at most two.
        const batch = await ctx.annotations.listObjects({
          after: progress.after,
          limit,
          named,
        });
        // An empty batch ends its pass, so the loop ends.
        budget -= batch.length;
        const moves = new Map<string, [from: string, to: string]>();
        const objects = batch.flatMap((annotation) => {
          const ref = objectRef(annotation);
          return ref ? [{ key: annotation.key, ref }] : [];
        });
        if (objects.length > 0) {
          // oxlint-disable-next-line no-await-in-loop -- The token loads once per slice.
          const names = (reader ??= await loadNames());
          // oxlint-disable-next-line no-await-in-loop -- See above.
          await pLimit(READ_CONCURRENCY).map(objects, async ({ key, ref }) => {
            let name: GitHubObjectName | undefined;
            let renamed: string | undefined;
            const stored = `${ref.owner}/${ref.name}`;
            try {
              name = await names.readObject(ref);
              const current = name && repositoryOf(name.url);
              renamed = current && (await renamedTo(names, stored, current));
            } catch (error) {
              if (!ctx.lastDelivery) {
                failure ??= error;
                return;
              }
              ctx.log.error("GitHub Annotation object read failed", {}, error);
              return;
            }
            if (!name) return;
            // A named object is no longer listed on a retry, so its move is
            // kept before the write that names it can fail.
            if (renamed) moves.set(stored.toLowerCase(), [stored, renamed]);
            if (named) return;
            try {
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
            } catch (error) {
              failure ??= error;
            }
          });
        }
        // A move changes keys of the batch and of later rows, so it runs
        // after the batch. In the unnamed pass, the pass then starts over,
        // so a moved object is still named. Each move names at least one
        // object, so this ends. A moved object with its id needs nothing
        // more.
        const renames = orderRepositoryRenames(moves.values());
        for (const [from, to] of renames.ordered) {
          // oxlint-disable-next-line no-await-in-loop -- Few repositories move, and each move is one write.
          await ctx.annotations.objectsMoved(githubRepositoryMove(from, to));
        }
        for (const [from, to] of renames.cyclic) {
          ctx.log.error("GitHub repository renames form a cycle", { from, to });
        }
        const last = batch.at(-1);
        if (!named && renames.ordered.length > 0) {
          progress = { pass: "unnamed", slices: progress.slices };
        } else if (failure !== undefined) {
          break;
        } else if (last && batch.length === limit) {
          progress = { ...progress, after: last.key };
        } else if (named) {
          progress = { pass: "unnamed", slices: progress.slices };
        } else {
          progress = { done: true, pass: "unnamed", slices: progress.slices };
        }
      }
      if (failure !== undefined) {
        if (progress !== start) await ctx.state.set(PROGRESS_KEY, progress);
        throw failure;
      }
      await ctx.state.set(PROGRESS_KEY, {
        ...progress,
        slices: start.slices + 1,
      });
    },
  };
}
