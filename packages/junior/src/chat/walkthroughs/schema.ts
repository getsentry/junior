/**
 * Runtime schemas for Walkthroughs.
 *
 * The model writes a `WalkthroughOutput`. It cites code by PR, file, and line
 * range, and messages by their seq in the source Conversation. It never copies
 * code or text. Junior adds the parts that do not need a model (layers, code
 * excerpts, message text, skipped files, checks, cost) and stores a
 * `WalkthroughDocument`. The dashboard renders only the stored document.
 *
 * A Walkthrough is one story for the whole stack. Chapters follow the
 * story, not the PRs or commits, so the schema fixes no chapter structure.
 * Text limits keep each chapter a short paragraph.
 */
import * as z from "zod";

export const WALKTHROUGH_SCHEMA_VERSION = 3;

/** Stable slug. Chapter and decision ids stay the same across versions. */
const idSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,47}$/, "Use a lowercase slug.");
const sentence = (max: number) => z.string().trim().min(1).max(max);
const caption = sentence(160);
const shaSchema = z.string().regex(/^[0-9a-f]{7,40}$/);

/**
 * Kinds of change. They suggest chapters in the skill; they fix nothing here.
 * A mixed change has more than one.
 */
const WALKTHROUGH_CHANGE_TYPES = [
  "feature",
  "bug_fix",
  "refactor",
  "migration",
  "dependency",
  "performance",
  "ui",
] as const;

/**
 * The diagram of one code change. Chapters choose what to show. A stack gets
 * one diagram per code change, so no picture grows past what a reader can
 * follow. Junior lays it out; the model only names nodes and edges.
 */
const diagramSchema = z
  .object({
    pr: z.number().int().positive(),
    nodes: z
      .array(z.object({ id: idSchema, label: sentence(32) }).strict())
      .min(1)
      .max(10),
    edges: z
      .array(
        z
          .object({
            id: idSchema,
            from: idSchema,
            to: idSchema,
            label: sentence(32).optional(),
          })
          .strict(),
      )
      .max(14),
  })
  .strict();

const diagramViewSchema = z
  .object({
    /** The code change whose diagram this view shows. */
    pr: z.number().int().positive(),
    /** Node and edge ids. Others are dimmed. */
    show: z.array(idSchema).min(1),
    highlight: z.array(idSchema).default([]),
    /** Nodes or edges that are new in this change. */
    added: z.array(idSchema).default([]),
    broken: z
      .array(z.object({ id: idSchema, label: sentence(40) }).strict())
      .default([]),
  })
  .strict();

/**
 * Code at a commit. `head` lines are in the PR head commit and `base` lines are
 * in its base commit, so removed code is cited on the base side. A `base`
 * range must fall inside one diff hunk. A `head` range can also cite a file
 * outside the diff, such as a caller of changed code.
 */
const codeCitationFields = {
  pr: z.number().int().positive(),
  path: z.string().min(1),
  side: z.enum(["head", "base"]).default("head"),
  start: z.number().int().positive(),
  end: z.number().int().positive(),
};

/** Every claim points at something Junior can resolve and the reader can open. */
const evidenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("code"),
      ...codeCitationFields,
      note: sentence(120).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("message"),
      /** Seq of a message in the source Conversation. */
      seq: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("link"),
      /** Must appear in a PR body or a cited message, so it is not made up. */
      url: z.string().url(),
      label: sentence(60),
    })
    .strict(),
  z
    .object({
      kind: z.literal("check"),
      /** Id of a deterministic check result, such as CI or a move detector. */
      check_id: z.string().min(1),
    })
    .strict(),
]);

/** A code citation without its note. */
export type WalkthroughCodeRef = {
  pr: number;
  path: string;
  side: "head" | "base";
  start: number;
  end: number;
};

/** Key of the excerpt that Junior stores for one code citation. */
export function codeExcerptId(ref: WalkthroughCodeRef): string {
  return `${ref.pr}:${ref.side}:${ref.path}#${ref.start}-${ref.end}`;
}

/** Why a reader must decide something. */
const decisionOriginSchema = z.discriminatedUnion("kind", [
  /** The source Conversation assumed this and nobody confirmed it. */
  z.object({ kind: z.literal("assumed") }).strict(),
  z.object({ kind: z.literal("behavior_change") }).strict(),
  z.object({ kind: z.literal("missing_signal") }).strict(),
  z.object({ kind: z.literal("not_asked") }).strict(),
]);

/**
 * A claim the reader agrees with or asks to change, such as "Retrying three
 * times is enough for a lost lock." It is a statement, so an answer to it
 * reads as a review. `concern` says what could make the claim wrong.
 */
const decisionSchema = z
  .object({
    id: idSchema,
    claim: sentence(160),
    concern: sentence(160).optional(),
    origin: decisionOriginSchema,
    /** Index into this chapter's evidence. */
    evidence: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * Prose under the caption: the story for a reader with no context. It cites
 * evidence by 1-based index, such as "[2]", and cites every piece. One short
 * paragraph, so the prose alone carries the reader.
 */
const bodySchema = z.string().trim().min(1).max(600);

/**
 * What a chapter is for. The type of change picks what the opening says, so
 * this names only the purposes every Walkthrough needs: an opening first,
 * and a chapter on how we know it works. Older documents have none.
 */
const chapterRoleSchema = z.enum(["opening", "proof", "other"]);

/**
 * One chapter of the story. An opening may cite nothing; `validateWalkthrough`
 * checks that every other chapter cites evidence.
 */
export const walkthroughChapterSchema = z
  .object({
    id: idSchema,
    /** The chapter title: a few words, such as "Root cause" or "The fix". */
    label: sentence(40),
    caption,
    role: chapterRoleSchema.default("other"),
    body: bodySchema,
    view: diagramViewSchema.optional(),
    evidence: z.array(evidenceSchema).max(6),
    decisions: z.array(decisionSchema).max(3).default([]),
    /** Questions a reader is likely to ask here. */
    asks: z.array(sentence(80)).max(3).default([]),
  })
  .strict();

/**
 * Changed files that no chapter cites, grouped by why the story leaves them
 * out, such as "Tests of the validator". The reader still sees them.
 */
const alsoChangedSchema = z
  .array(
    z
      .object({
        reason: sentence(80),
        files: z
          .array(
            z
              .object({
                pr: z.number().int().positive(),
                path: z.string().min(1),
              })
              .strict(),
          )
          .min(1),
      })
      .strict(),
  )
  .default([]);

/** What the model writes for a first, full generation. */
export const walkthroughOutputSchema = z
  .object({
    /** The outcome, not the mechanism. */
    title: sentence(100),
    /**
     * One sentence that says what kind of change this is before anything
     * else, such as "This PR fixes a bug where…" or "This stack adds…".
     */
    intent: sentence(200),
    /** What kind of change the whole Walkthrough is. */
    types: z.array(z.enum(WALKTHROUGH_CHANGE_TYPES)).min(1).max(3),
    diagrams: z.array(diagramSchema).min(1).max(10),
    /** `validateWalkthrough` caps the count by stack size. */
    chapters: z.array(walkthroughChapterSchema).min(1).max(10),
    /** Every changed file that is not mechanical and that no chapter cites. */
    also_changed: alsoChangedSchema,
  })
  .strict();

/**
 * What the model writes for an update. Old chapters stay frozen: each item
 * says what changed in one of them and why.
 */
export const walkthroughUpdateOutputSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            id: idSchema,
            /** Chapter id in the previous version. */
            touches: idSchema,
            /** Decision id with "change" feedback that this item answers. */
            answers: idSchema.optional(),
            caption,
            body: bodySchema,
            evidence: z.array(evidenceSchema).min(1).max(3),
            decisions: z.array(decisionSchema).max(2).default([]),
          })
          .strict(),
      )
      .max(8),
    /** New concerns that do not fit an old chapter. */
    added_chapters: z.array(walkthroughChapterSchema).max(4).default([]),
    also_changed: alsoChangedSchema,
  })
  .strict();

const diffLineSchema = z
  .object({
    kind: z.enum(["add", "remove", "context"]),
    /** Source code, not display text. */
    content: z.string().max(400),
    oldLine: z.number().int().positive().optional(),
    newLine: z.number().int().positive().optional(),
  })
  .strict();

/**
 * The diff lines for one code citation, copied from the provider diff by
 * Junior, never by the model. `id` is `codeExcerptId` of the citation.
 */
export const walkthroughExcerptSchema = z
  .object({
    id: z.string().min(1),
    ...codeCitationFields,
    language: z.string().min(1).optional(),
    /** Provider permalink to `start`, at the cited commit. */
    url: z.string().url().optional(),
    lines: z.array(diffLineSchema).min(1),
  })
  .strict();

/** Stored Walkthrough version: model output plus deterministic parts. */
export const walkthroughDocumentSchema = z
  .object({
    schemaVersion: z.literal(WALKTHROUGH_SCHEMA_VERSION),
    versionId: z.string().min(1),
    parentVersionId: z.string().min(1).optional(),
    /** The version whose full generation wrote `content`. */
    contentVersionId: z.string().min(1),
    repository: sentence(200),
    layers: z
      .array(
        z
          .object({
            pr: z.number().int().positive(),
            title: sentence(200),
            url: z.string().url(),
            headSha: shaSchema,
            baseSha: shaSchema,
            additions: z.number().int().nonnegative(),
            deletions: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .min(1),
    excerpts: z.array(walkthroughExcerptSchema),
    /** Mechanical changes that never reach the model. Only counts are shown. */
    skipped: z.array(
      z
        .object({
          reason: z.enum([
            "generated",
            "lockfile",
            "no_diff",
            "rename",
            "whitespace",
          ]),
          files: z.number().int().positive(),
          lines: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    checks: z.array(
      z
        .object({
          id: z.string().min(1),
          label: sentence(120),
          /** What ran and where, such as the base and head results. */
          detail: sentence(160).optional(),
          status: z.enum(["passed", "failed", "pending"]),
          url: z.string().url().optional(),
        })
        .strict(),
    ),
    /** The Conversation that opened the code change, when it was readable. */
    sourceConversationId: z.string().min(1).optional(),
    /** Text of the cited messages, copied by Junior at generation time. */
    messages: z.array(
      z
        .object({
          seq: z.number().int().nonnegative(),
          role: z.enum(["user", "assistant"]),
          text: z.string().min(1).max(400),
        })
        .strict(),
    ),
    content: walkthroughOutputSchema,
    /**
     * Fingerprint of each changed file's diff. The next version compares
     * them to find the code that changed, so a rebase alone changes nothing.
     */
    files: z
      .array(
        z
          .object({
            pr: z.number().int().positive(),
            path: z.string().min(1),
            hash: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
    /** Update layers on top of `content`, oldest first. */
    updates: z.array(
      walkthroughUpdateOutputSchema.extend({
        versionId: z.string().min(1),
        createdAt: z.string().datetime(),
        /** Chapters whose cited code changed. Their decisions reopen. */
        changedChapters: z.array(idSchema),
        /** Layers whose commits moved since the previous version. */
        movedLayers: z.array(z.number().int().positive()),
        /** Layers that joined the stack. */
        newLayers: z.array(z.number().int().positive()),
        /** Layers that left the stack, such as by merging. */
        leftLayers: z.array(
          z
            .object({
              pr: z.number().int().positive(),
              title: sentence(200),
              url: z.string().url(),
            })
            .strict(),
        ),
      }),
    ),
    meta: z
      .object({
        modelId: z.string().min(1),
        promptVersion: z.number().int().positive(),
        costUsd: z.number().nonnegative().optional(),
        createdAt: z.string().datetime(),
      })
      .strict(),
  })
  .strict();

export type WalkthroughOutput = z.infer<typeof walkthroughOutputSchema>;
export type WalkthroughUpdateOutput = z.infer<
  typeof walkthroughUpdateOutputSchema
>;
export type WalkthroughUpdate = WalkthroughDocument["updates"][number];
export type WalkthroughChapter = z.infer<typeof walkthroughChapterSchema>;
export type WalkthroughEvidence = z.infer<typeof evidenceSchema>;
export type WalkthroughDecision = z.infer<typeof decisionSchema>;
export type WalkthroughDiagram = z.infer<typeof diagramSchema>;
export type WalkthroughExcerpt = z.infer<typeof walkthroughExcerptSchema>;
export type WalkthroughDocument = z.infer<typeof walkthroughDocumentSchema>;
