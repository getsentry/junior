import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  eq,
  gt,
  gte,
  isNull,
  notExists,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { JuniorDatabase } from "@/db/db";
import {
  conversationBriefSchema,
  type ConversationBrief,
} from "@/chat/briefs/schema";
import {
  juniorConversationBriefs,
  juniorConversationSpaces,
  juniorConversations,
  juniorDestinations,
} from "@/db/schema";
import { applySpaceClassification } from "./assign";
import { classifyConversationSpace } from "./classify";
import { readSpaceTree } from "./store";
import { buildSpaceTree, topLevelSpaceIds } from "./tree";
import type { ConversationKind, Space, SpaceNode } from "./types";

type ClassifierCompleteObject = Parameters<
  typeof classifyConversationSpace
>[0]["completeObject"];

/** One unassigned root Conversation with a Brief. */
export interface SpaceBackfillCandidate {
  conversationId: string;
  title?: string;
  channelName?: string;
  isPublic: boolean;
  createdAtMs: number;
  brief: ConversationBrief;
}

/**
 * Read unassigned root Conversations that have a Brief, oldest first. The
 * backfill replays them in this order so the tree grows the way it would
 * have grown at runtime.
 */
export async function readSpaceBackfillCandidates(
  db: JuniorDatabase,
  args: { limit?: number; sinceMs?: number } = {},
): Promise<SpaceBackfillCandidate[]> {
  const briefs = juniorConversationBriefs;
  const newer = alias(juniorConversationBriefs, "newer_backfill_briefs");
  const conditions: SQL[] = [
    isNull(juniorConversations.parentConversationId),
    notExists(
      db
        .select({ one: sql`1` })
        .from(newer)
        .where(
          and(
            eq(newer.conversationId, briefs.conversationId),
            gt(newer.version, briefs.version),
          ),
        ),
    ),
    notExists(
      db
        .select({ one: sql`1` })
        .from(juniorConversationSpaces)
        .where(
          eq(
            juniorConversationSpaces.conversationId,
            juniorConversations.conversationId,
          ),
        ),
    ),
  ];
  if (args.sinceMs !== undefined) {
    conditions.push(gte(juniorConversations.createdAt, new Date(args.sinceMs)));
  }
  const query = db
    .select({
      conversationId: juniorConversations.conversationId,
      title: juniorConversations.title,
      channelName: juniorConversations.channelName,
      visibility: juniorDestinations.visibility,
      createdAt: juniorConversations.createdAt,
      content: briefs.content,
    })
    .from(briefs)
    .innerJoin(
      juniorConversations,
      eq(juniorConversations.conversationId, briefs.conversationId),
    )
    .leftJoin(
      juniorDestinations,
      eq(juniorDestinations.id, juniorConversations.destinationId),
    )
    .where(and(...conditions))
    .orderBy(
      asc(juniorConversations.createdAt),
      asc(juniorConversations.conversationId),
    );
  const rows = await (args.limit !== undefined
    ? query.limit(args.limit)
    : query);
  return rows.map((row) => ({
    conversationId: row.conversationId,
    ...(row.title ? { title: row.title } : undefined),
    ...(row.channelName ? { channelName: row.channelName } : undefined),
    isPublic: row.visibility === "public",
    createdAtMs: row.createdAt.getTime(),
    brief: conversationBriefSchema.parse(row.content),
  }));
}

/** Outcome of one backfill run. */
export interface SpaceBackfillResult {
  tree: Map<string, SpaceNode>;
  /** Candidates handled before the run finished or stopped. */
  processed: number;
  /** Candidates the run was given. */
  total: number;
  assigned: number;
  unassigned: number;
  createdSpaces: number;
  costUsd: number;
  /** Up to three public titles per Space, for review. */
  samples: Map<string, string[]>;
  /** Classified Conversations per kind of work. */
  kinds: Map<ConversationKind, number>;
}

/**
 * Replay the runtime classifier over Conversations in historic order.
 *
 * A dry run grows an in-memory copy of the current tree and writes nothing.
 * An applied run writes each Space and assignment through the store, with
 * the `backfill` actor, so every step lands in the change log.
 */
export async function runSpaceBackfill(
  db: JuniorDatabase,
  args: {
    candidates: readonly SpaceBackfillCandidate[];
    completeObject: ClassifierCompleteObject;
    apply: boolean;
    onProgress?: (done: number, total: number) => void;
    /** Checked before each candidate. True stops the run early. */
    shouldStop?: () => boolean;
  },
): Promise<SpaceBackfillResult> {
  const initial = await readSpaceTree(db);
  // Dry-run state: plain Spaces plus direct Conversation counts.
  const spaces: Space[] = [...initial.values()].map((node) => ({
    spaceId: node.spaceId,
    ...(node.parentSpaceId ? { parentSpaceId: node.parentSpaceId } : undefined),
    name: node.name,
    description: node.description,
    createdAtMs: node.createdAtMs,
    updatedAtMs: node.updatedAtMs,
  }));
  const counts = new Map(
    [...initial.values()].map((node) => [
      node.spaceId,
      { conversationCount: node.conversationCount },
    ]),
  );
  let tree = initial;
  const samples = new Map<string, string[]>();
  let assigned = 0;
  let unassigned = 0;
  let createdSpaces = 0;
  let costUsd = 0;
  let processed = 0;
  const kinds = new Map<ConversationKind, number>();

  for (const [index, candidate] of args.candidates.entries()) {
    if (args.shouldStop?.()) break;
    processed = index + 1;
    if (!candidate.isPublic && tree.size === 0) {
      unassigned += 1;
      args.onProgress?.(index + 1, args.candidates.length);
      continue;
    }
    const result = await classifyConversationSpace({
      completeObject: args.completeObject,
      conversation: {
        ...(candidate.title ? { title: candidate.title } : undefined),
        ...(candidate.channelName
          ? { channelName: candidate.channelName }
          : undefined),
        brief: candidate.brief,
      },
      tree,
      allowCreate: candidate.isPublic,
    });
    costUsd += result.costUsd ?? 0;
    const classification = result.classification;
    if (!classification) {
      unassigned += 1;
      args.onProgress?.(index + 1, args.candidates.length);
      continue;
    }
    kinds.set(
      classification.conversationKind,
      (kinds.get(classification.conversationKind) ?? 0) + 1,
    );

    let spaceId: string;
    if (args.apply) {
      const applied = await applySpaceClassification(db, {
        conversationId: candidate.conversationId,
        classification,
        actor: { kind: "backfill" },
        isPublic: candidate.isPublic,
      });
      spaceId = applied.space.spaceId;
      if (applied.created) createdSpaces += 1;
      tree = await readSpaceTree(db);
    } else {
      if (classification.kind === "create") {
        spaceId = `dry-run:${randomUUID()}`;
        spaces.push({
          spaceId,
          ...(classification.parentSpaceId
            ? { parentSpaceId: classification.parentSpaceId }
            : undefined),
          name: classification.name,
          description: classification.description,
          createdAtMs: candidate.createdAtMs,
          updatedAtMs: candidate.createdAtMs,
        });
        createdSpaces += 1;
      } else {
        spaceId = classification.spaceId;
      }
      counts.set(spaceId, {
        conversationCount: (counts.get(spaceId)?.conversationCount ?? 0) + 1,
      });
      tree = buildSpaceTree(spaces, counts);
    }
    assigned += 1;
    if (candidate.isPublic && candidate.title) {
      const titles = samples.get(spaceId) ?? [];
      if (titles.length < 3) titles.push(candidate.title);
      samples.set(spaceId, titles);
    }
    args.onProgress?.(index + 1, args.candidates.length);
  }
  return {
    tree,
    processed,
    total: args.candidates.length,
    assigned,
    unassigned,
    createdSpaces,
    costUsd,
    samples,
    kinds,
  };
}

/** Render a backfill result as a Markdown outline for review. */
export function renderSpaceBackfillMarkdown(
  result: SpaceBackfillResult,
  options: { apply: boolean },
): string {
  const lines = [
    `# Space backfill (${options.apply ? "applied" : "dry run"})`,
    "",
    ...(result.processed < result.total
      ? [
          `- Stopped early after ${result.processed} of ${result.total} Conversations to stay inside the Turn time limit. Run again to continue.`,
        ]
      : []),
    `- Conversations assigned: ${result.assigned}`,
    `- Conversations left unassigned: ${result.unassigned}`,
    `- Spaces created: ${result.createdSpaces}`,
    `- Spaces in tree: ${result.tree.size}`,
    ...(result.kinds.size > 0
      ? [
          `- Kinds: ${[...result.kinds.entries()]
            .sort((left, right) => right[1] - left[1])
            .map(([kind, total]) => `${total} ${kind}`)
            .join(", ")}`,
        ]
      : []),
    `- Model cost: $${result.costUsd.toFixed(4)}`,
    "",
  ];
  const visit = (spaceId: string) => {
    const node = result.tree.get(spaceId)!;
    const indent = "  ".repeat(node.depth - 1);
    lines.push(
      `${indent}- **${node.name}** (${node.totalConversationCount})${node.description ? ` — ${node.description}` : ""}`,
    );
    for (const title of result.samples.get(spaceId) ?? []) {
      lines.push(`${indent}  - _${title.replace(/\s+/g, " ").trim()}_`);
    }
    node.childSpaceIds.forEach(visit);
  };
  topLevelSpaceIds(result.tree).forEach(visit);
  if (result.tree.size === 0) lines.push("(no Spaces)");
  return `${lines.join("\n")}\n`;
}
