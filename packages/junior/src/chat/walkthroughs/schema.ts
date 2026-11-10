/**
 * Runtime schemas for Walkthroughs.
 *
 * The model writes a `WalkthroughOutput`. It names hunks by id and never
 * copies code. Junior adds the parts that do not need a model (layers, hunk
 * bodies, skipped files, checks, cost) and stores a `WalkthroughDocument`. The
 * dashboard renders only the stored document.
 *
 * Text limits are part of the contract. A caption is one sentence, so a
 * Walkthrough stays a story and does not turn into a wall of text.
 */
import * as z from "zod";

export const WALKTHROUGH_SCHEMA_VERSION = 1;

/** Stable slug. Chapter and decision ids stay the same across versions. */
const idSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,47}$/, "Use a lowercase slug.");
const sentence = (max: number) => z.string().trim().min(1).max(max);
const caption = sentence(160);
const shaSchema = z.string().regex(/^[0-9a-f]{7,40}$/);

/**
 * Change types and their fixed slots, in reading order. The model fills slots.
 * It does not invent structure, so every bug fix reads the same way.
 */
export const WALKTHROUGH_TEMPLATES = {
  feature: ["how_it_works", "gap", "change"],
  bug_fix: ["broken", "cause", "fix", "side_effects", "proof"],
  refactor: ["claim", "proof", "exceptions"],
  migration: ["why", "change", "safe_to_run", "rollback"],
  dependency: ["what_changed", "blast_radius", "rollback"],
  performance: ["hot_path", "change", "numbers"],
  ui: ["before_after"],
  ship_check: ["after_ship"],
} as const;

export type WalkthroughChangeType = keyof typeof WALKTHROUGH_TEMPLATES;

/** One diagram for the whole Walkthrough. Chapters choose what to show. */
const diagramSchema = z
  .object({
    nodes: z
      .array(
        z
          .object({
            id: idSchema,
            label: sentence(32),
            // A small grid, not pixels. The renderer owns layout.
            column: z.number().int().min(0).max(4),
            row: z.number().int().min(0).max(3),
          })
          .strict(),
      )
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

/** Every claim points at something Junior can resolve and the reader can open. */
const evidenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("hunk"),
      hunkId: z.string().min(1),
      /** Lines inside the hunk to show, as 1-based offsets. Omit for all. */
      lines: z
        .object({
          start: z.number().int().positive(),
          end: z.number().int().positive(),
        })
        .strict()
        .optional(),
      note: sentence(120).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("source"),
      /** Id of a Brief fact, Brief decision, PR body line, or Sentry link. */
      sourceId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("check"),
      /** Id of a deterministic check result, such as CI or a move detector. */
      checkId: z.string().min(1),
    })
    .strict(),
]);

/** Why a reader must decide something. */
const decisionOriginSchema = z.discriminatedUnion("kind", [
  /** The Brief marked this decision as assumed, not confirmed. */
  z
    .object({ kind: z.literal("assumed"), sourceId: z.string().min(1) })
    .strict(),
  z.object({ kind: z.literal("behavior_change") }).strict(),
  z.object({ kind: z.literal("missing_signal") }).strict(),
  z.object({ kind: z.literal("not_asked") }).strict(),
]);

const decisionSchema = z
  .object({
    id: idSchema,
    question: sentence(160),
    origin: decisionOriginSchema,
    /** Index into this chapter's evidence. */
    evidence: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * Short prose under the caption: the story for a reader with no context. It
 * cites evidence by 1-based index, such as "[2]", and cites every piece.
 * Two or three sentences, not a wall of text.
 */
const bodySchema = z.string().trim().min(1).max(360);

const chapterBase = {
  id: idSchema,
  caption,
  body: bodySchema,
  view: diagramViewSchema.optional(),
  evidence: z.array(evidenceSchema).max(4).default([]),
  decisions: z.array(decisionSchema).max(3).default([]),
  /** Questions a reader is likely to ask here. */
  asks: z.array(sentence(80)).max(3).default([]),
};

const changeTypes = Object.keys(WALKTHROUGH_TEMPLATES) as [
  WalkthroughChangeType,
  ...WalkthroughChangeType[],
];
const slots = [...new Set(Object.values(WALKTHROUGH_TEMPLATES).flat())] as [
  string,
  ...string[],
];

/**
 * One flat chapter shape. A union per change type would repeat the chapter
 * body in the JSON Schema eight times. `findWalkthroughProblems` checks that
 * the slot belongs to the type.
 */
export const walkthroughChapterSchema = z
  .object({
    ...chapterBase,
    type: z.enum(changeTypes),
    slot: z.enum(slots),
  })
  .strict();

const notCoveredSchema = z
  .array(
    z.object({ hunkId: z.string().min(1), reason: sentence(120) }).strict(),
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
    diagram: diagramSchema,
    chapters: z.array(walkthroughChapterSchema).min(1).max(12),
    /** A layer that mixes change types, such as a feature and a refactor. */
    splits: z
      .array(
        z.object({ pr: z.number().int().positive(), reason: caption }).strict(),
      )
      .default([]),
    /** Every hunk that is not mechanical and that no chapter cites. */
    notCovered: notCoveredSchema,
  })
  .strict();

/** What the model writes for an update. Old chapters stay frozen. */
export const walkthroughUpdateOutputSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            id: idSchema,
            /** Chapter id in the parent version. */
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
    addedChapters: z.array(walkthroughChapterSchema).max(4).default([]),
    notCovered: notCoveredSchema,
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

/** A hunk copied from the provider diff by Junior, never by the model. */
export const walkthroughHunkSchema = z
  .object({
    id: z.string().min(1),
    pr: z.number().int().positive(),
    path: z.string().min(1),
    language: z.string().min(1).optional(),
    /** Provider permalink to the first changed line, at its commit. */
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
    /** The Conversation that made the PR. Brief sources link to it. */
    conversationId: z.string().min(1).optional(),
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
    hunks: z.array(walkthroughHunkSchema),
    /** Mechanical changes that never reach the model. Only counts are shown. */
    skipped: z.array(
      z
        .object({
          reason: z.enum([
            "generated",
            "lockfile",
            "moved",
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
    /** Text that `source` evidence cites, resolved at generation time. */
    sources: z.array(
      z
        .object({
          id: z.string().min(1),
          kind: z.enum(["brief_fact", "brief_decision", "pr_body", "sentry"]),
          text: z.string().min(1).max(400),
          /** The Brief decision's own kind. Only `brief_decision` has it. */
          decisionKind: z.enum(["stated", "confirmed", "assumed"]).optional(),
          url: z.string().url().optional(),
        })
        .strict(),
    ),
    content: walkthroughOutputSchema,
    /** Update layers on top of `content`, oldest first. */
    updates: z.array(
      walkthroughUpdateOutputSchema.extend({
        versionId: z.string().min(1),
        pushes: z.number().int().positive(),
        createdAt: z.string().datetime(),
      }),
    ),
    meta: z
      .object({
        modelId: z.string().min(1),
        promptVersion: z.number().int().positive(),
        briefVersion: z.number().int().positive().optional(),
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
export type WalkthroughChapter = z.infer<typeof walkthroughChapterSchema>;
export type WalkthroughEvidence = z.infer<typeof evidenceSchema>;
export type WalkthroughDecision = z.infer<typeof decisionSchema>;
export type WalkthroughHunk = z.infer<typeof walkthroughHunkSchema>;
export type WalkthroughDocument = z.infer<typeof walkthroughDocumentSchema>;
