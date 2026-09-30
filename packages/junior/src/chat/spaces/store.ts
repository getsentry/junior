import { randomUUID } from "node:crypto";
import {
  and,
  count,
  desc,
  eq,
  gt,
  inArray,
  max,
  notExists,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversationBriefs,
  juniorConversationSpaces,
  juniorConversations,
  juniorDestinations,
  juniorSpaceChanges,
  juniorSpaces,
} from "@/db/schema";
import {
  buildSpaceTree,
  findSiblingByName,
  MAX_SPACE_DEPTH,
  normalizeSpaceDescription,
  normalizeSpaceName,
  SpaceInputError,
  subtreeHeight,
  subtreeSpaceIds,
} from "./tree";
import type {
  Space,
  SpaceActor,
  SpaceActorKind,
  SpaceChangeKind,
  SpaceNode,
} from "./types";

type Tx = Parameters<Parameters<JuniorDatabase["transaction"]>[0]>[0];
type Db = JuniorDatabase | Tx;
type SpaceRow = typeof juniorSpaces.$inferSelect;

function spaceFromRow(row: SpaceRow): Space {
  return {
    spaceId: row.spaceId,
    ...(row.parentSpaceId ? { parentSpaceId: row.parentSpaceId } : undefined),
    name: row.name,
    description: row.description,
    createdAtMs: row.createdAt.getTime(),
    updatedAtMs: row.updatedAt.getTime(),
  };
}

/** Serialize every tree mutation so cycle and depth checks stay valid. */
async function lockTree(tx: Tx): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('junior_spaces'))`,
  );
}

async function appendChange(
  tx: Db,
  change: {
    kind: SpaceChangeKind;
    spaceId: string;
    actor: SpaceActor;
    conversationId?: string;
    reason?: string;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(juniorSpaceChanges).values({
    changeId: randomUUID(),
    kind: change.kind,
    spaceId: change.spaceId,
    conversationId: change.conversationId ?? null,
    actorKind: change.actor.kind,
    actorConversationId: change.actor.conversationId ?? null,
    reason: change.reason?.trim() || null,
    before: change.before ?? null,
    after: change.after ?? null,
  });
}

/** Read the active Space tree with Conversation counts and last activity. */
export async function readSpaceTree(db: Db): Promise<Map<string, SpaceNode>> {
  const [rows, activityRows] = await Promise.all([
    db.select().from(juniorSpaces).where(eq(juniorSpaces.status, "active")),
    db
      .select({
        spaceId: juniorConversationSpaces.spaceId,
        conversationCount: count(),
        lastActivityAt: max(juniorConversations.lastActivityAt),
      })
      .from(juniorConversationSpaces)
      .innerJoin(
        juniorConversations,
        eq(
          juniorConversations.conversationId,
          juniorConversationSpaces.conversationId,
        ),
      )
      .groupBy(juniorConversationSpaces.spaceId),
  ]);
  const activity = new Map(
    activityRows.map((row) => [
      row.spaceId,
      {
        conversationCount: Number(row.conversationCount),
        ...(row.lastActivityAt
          ? { lastActivityAtMs: row.lastActivityAt.getTime() }
          : undefined),
      },
    ]),
  );
  return buildSpaceTree(rows.map(spaceFromRow), activity);
}

function requireSpace(
  tree: ReadonlyMap<string, SpaceNode>,
  spaceId: string,
): SpaceNode {
  const node = tree.get(spaceId);
  if (!node) {
    throw new SpaceInputError(`Space ${spaceId} does not exist or is inactive`);
  }
  return node;
}

function requireFreeName(
  tree: ReadonlyMap<string, SpaceNode>,
  parentSpaceId: string | undefined,
  name: string,
  exceptSpaceId?: string,
): void {
  const sibling = findSiblingByName(tree, parentSpaceId, name);
  if (sibling && sibling.spaceId !== exceptSpaceId) {
    throw new SpaceInputError(
      `A Space named "${sibling.name}" already exists here (${sibling.spaceId})`,
    );
  }
}

/** Create one Space under an optional active parent. */
export async function createSpace(
  db: JuniorDatabase,
  input: {
    name: string;
    description?: string;
    parentSpaceId?: string;
    actor: SpaceActor;
    reason?: string;
  },
): Promise<SpaceNode> {
  const name = normalizeSpaceName(input.name);
  const description = normalizeSpaceDescription(input.description ?? "");
  return await db.transaction(async (tx) => {
    await lockTree(tx);
    const tree = await readSpaceTree(tx);
    const parent = input.parentSpaceId
      ? requireSpace(tree, input.parentSpaceId)
      : undefined;
    if ((parent?.depth ?? 0) + 1 > MAX_SPACE_DEPTH) {
      throw new SpaceInputError(
        `Spaces can be at most ${MAX_SPACE_DEPTH} levels deep`,
      );
    }
    requireFreeName(tree, parent?.spaceId, name);
    const spaceId = randomUUID();
    await tx.insert(juniorSpaces).values({
      spaceId,
      parentSpaceId: parent?.spaceId ?? null,
      name,
      description,
      createdBy: input.actor.kind,
    });
    await appendChange(tx, {
      kind: "create",
      spaceId,
      actor: input.actor,
      ...(input.reason ? { reason: input.reason } : undefined),
      after: { name, description, parentSpaceId: parent?.spaceId ?? null },
    });
    return requireSpace(await readSpaceTree(tx), spaceId);
  });
}

/** Rename or describe one active Space. */
export async function updateSpace(
  db: JuniorDatabase,
  input: {
    spaceId: string;
    name?: string;
    description?: string;
    actor: SpaceActor;
    reason?: string;
  },
): Promise<SpaceNode> {
  const name =
    input.name !== undefined ? normalizeSpaceName(input.name) : undefined;
  const description =
    input.description !== undefined
      ? normalizeSpaceDescription(input.description)
      : undefined;
  if (name === undefined && description === undefined) {
    throw new SpaceInputError("Provide a new name or description");
  }
  return await db.transaction(async (tx) => {
    await lockTree(tx);
    const tree = await readSpaceTree(tx);
    const space = requireSpace(tree, input.spaceId);
    if (name !== undefined) {
      requireFreeName(tree, space.parentSpaceId, name, space.spaceId);
    }
    await tx
      .update(juniorSpaces)
      .set({
        ...(name !== undefined ? { name } : undefined),
        ...(description !== undefined ? { description } : undefined),
        updatedAt: new Date(),
      })
      .where(eq(juniorSpaces.spaceId, space.spaceId));
    await appendChange(tx, {
      kind: "update",
      spaceId: space.spaceId,
      actor: input.actor,
      ...(input.reason ? { reason: input.reason } : undefined),
      before: { name: space.name, description: space.description },
      after: {
        name: name ?? space.name,
        description: description ?? space.description,
      },
    });
    return requireSpace(await readSpaceTree(tx), space.spaceId);
  });
}

/**
 * Move one Space and its whole subtree under another parent, or to the top
 * level. Assigned Conversations move with it because they point at the Space.
 */
export async function moveSpace(
  db: JuniorDatabase,
  input: {
    spaceId: string;
    parentSpaceId?: string;
    actor: SpaceActor;
    reason?: string;
  },
): Promise<SpaceNode> {
  return await db.transaction(async (tx) => {
    await lockTree(tx);
    const tree = await readSpaceTree(tx);
    const space = requireSpace(tree, input.spaceId);
    const parent = input.parentSpaceId
      ? requireSpace(tree, input.parentSpaceId)
      : undefined;
    if (
      parent &&
      subtreeSpaceIds(tree, space.spaceId).includes(parent.spaceId)
    ) {
      throw new SpaceInputError(
        "A Space cannot move under itself or one of its descendants",
      );
    }
    if (
      (parent?.depth ?? 0) + subtreeHeight(tree, space.spaceId) >
      MAX_SPACE_DEPTH
    ) {
      throw new SpaceInputError(
        `The move would make Spaces deeper than ${MAX_SPACE_DEPTH} levels`,
      );
    }
    requireFreeName(tree, parent?.spaceId, space.name, space.spaceId);
    await tx
      .update(juniorSpaces)
      .set({ parentSpaceId: parent?.spaceId ?? null, updatedAt: new Date() })
      .where(eq(juniorSpaces.spaceId, space.spaceId));
    await appendChange(tx, {
      kind: "move",
      spaceId: space.spaceId,
      actor: input.actor,
      ...(input.reason ? { reason: input.reason } : undefined),
      before: { parentSpaceId: space.parentSpaceId ?? null },
      after: { parentSpaceId: parent?.spaceId ?? null },
    });
    return requireSpace(await readSpaceTree(tx), space.spaceId);
  });
}

/**
 * Merge one Space into another. Child Spaces and Conversations move to the
 * target. The source stays as a `merged` row so old ids still resolve.
 */
export async function mergeSpace(
  db: JuniorDatabase,
  input: {
    spaceId: string;
    intoSpaceId: string;
    actor: SpaceActor;
    reason?: string;
  },
): Promise<{ target: SpaceNode; movedConversations: number }> {
  return await db.transaction(async (tx) => {
    await lockTree(tx);
    const tree = await readSpaceTree(tx);
    const source = requireSpace(tree, input.spaceId);
    const target = requireSpace(tree, input.intoSpaceId);
    if (subtreeSpaceIds(tree, source.spaceId).includes(target.spaceId)) {
      throw new SpaceInputError(
        "A Space cannot merge into itself or one of its descendants",
      );
    }
    for (const childId of source.childSpaceIds) {
      const child = tree.get(childId)!;
      requireFreeName(tree, target.spaceId, child.name);
      if (target.depth + subtreeHeight(tree, childId) > MAX_SPACE_DEPTH) {
        throw new SpaceInputError(
          `The merge would make Spaces deeper than ${MAX_SPACE_DEPTH} levels`,
        );
      }
    }
    const now = new Date();
    if (source.childSpaceIds.length > 0) {
      await tx
        .update(juniorSpaces)
        .set({ parentSpaceId: target.spaceId, updatedAt: now })
        .where(inArray(juniorSpaces.spaceId, source.childSpaceIds));
    }
    const moved = await tx
      .update(juniorConversationSpaces)
      .set({ spaceId: target.spaceId })
      .where(eq(juniorConversationSpaces.spaceId, source.spaceId))
      .returning({ conversationId: juniorConversationSpaces.conversationId });
    await tx
      .update(juniorSpaces)
      .set({
        status: "merged",
        mergedIntoSpaceId: target.spaceId,
        updatedAt: now,
      })
      .where(eq(juniorSpaces.spaceId, source.spaceId));
    await appendChange(tx, {
      kind: "merge",
      spaceId: source.spaceId,
      actor: input.actor,
      ...(input.reason ? { reason: input.reason } : undefined),
      before: {
        childSpaceIds: source.childSpaceIds,
        conversationIds: moved.map((row) => row.conversationId),
      },
      after: { mergedIntoSpaceId: target.spaceId },
    });
    return {
      target: requireSpace(await readSpaceTree(tx), target.spaceId),
      movedConversations: moved.length,
    };
  });
}

/** Archive one empty Space. Move or merge its contents first. */
export async function archiveSpace(
  db: JuniorDatabase,
  input: { spaceId: string; actor: SpaceActor; reason?: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockTree(tx);
    const tree = await readSpaceTree(tx);
    const space = requireSpace(tree, input.spaceId);
    if (space.childSpaceIds.length > 0 || space.conversationCount > 0) {
      throw new SpaceInputError(
        "Only an empty Space can be archived. Move its child Spaces and Conversations, or merge it into another Space.",
      );
    }
    await tx
      .update(juniorSpaces)
      .set({ status: "archived", updatedAt: new Date() })
      .where(eq(juniorSpaces.spaceId, space.spaceId));
    await appendChange(tx, {
      kind: "archive",
      spaceId: space.spaceId,
      actor: input.actor,
      ...(input.reason ? { reason: input.reason } : undefined),
      before: { name: space.name, parentSpaceId: space.parentSpaceId ?? null },
    });
  });
}

/** Current primary Space of one Conversation. */
export interface ConversationSpaceAssignment {
  conversationId: string;
  spaceId: string;
  assignedBy: SpaceActorKind;
  confidence?: number;
  pinned: boolean;
  assignedAtMs: number;
}

/** Read the current Space assignment of one Conversation. */
export async function readConversationSpace(
  db: Db,
  conversationId: string,
): Promise<ConversationSpaceAssignment | undefined> {
  const rows = await db
    .select()
    .from(juniorConversationSpaces)
    .where(eq(juniorConversationSpaces.conversationId, conversationId))
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  return {
    conversationId: row.conversationId,
    spaceId: row.spaceId,
    assignedBy: row.assignedBy,
    ...(row.confidence !== null ? { confidence: row.confidence } : undefined),
    pinned: row.pinned,
    assignedAtMs: row.assignedAt.getTime(),
  };
}

/**
 * Assign root Conversations to one active Space. The classifier never
 * replaces a pinned assignment. A request pins the assignment it makes.
 */
export async function assignConversations(
  db: JuniorDatabase,
  input: {
    conversationIds: readonly string[];
    spaceId: string;
    actor: SpaceActor;
    confidence?: number;
    pinned: boolean;
    turnId?: string;
    /** Store only for public Conversations. */
    reason?: string;
  },
): Promise<{ assigned: string[]; skipped: string[] }> {
  const conversationIds = [...new Set(input.conversationIds)];
  if (conversationIds.length === 0) return { assigned: [], skipped: [] };
  return await db.transaction(async (tx) => {
    await lockTree(tx);
    const tree = await readSpaceTree(tx);
    requireSpace(tree, input.spaceId);
    const conversations = await tx
      .select({
        conversationId: juniorConversations.conversationId,
        parentConversationId: juniorConversations.parentConversationId,
      })
      .from(juniorConversations)
      .where(inArray(juniorConversations.conversationId, conversationIds));
    const found = new Map(
      conversations.map((row) => [row.conversationId, row]),
    );
    for (const conversationId of conversationIds) {
      const row = found.get(conversationId);
      if (!row) {
        throw new SpaceInputError(
          `Conversation ${conversationId} does not exist`,
        );
      }
      if (row.parentConversationId) {
        throw new SpaceInputError(
          `Conversation ${conversationId} is a child Conversation. Assign its root instead.`,
        );
      }
    }
    const existing = await tx
      .select()
      .from(juniorConversationSpaces)
      .where(inArray(juniorConversationSpaces.conversationId, conversationIds));
    const current = new Map(existing.map((row) => [row.conversationId, row]));
    const assigned: string[] = [];
    const skipped: string[] = [];
    for (const conversationId of conversationIds) {
      const previous = current.get(conversationId);
      if (
        (previous?.pinned && !input.pinned) ||
        (previous?.spaceId === input.spaceId &&
          previous.pinned === input.pinned)
      ) {
        skipped.push(conversationId);
        continue;
      }
      const values = {
        spaceId: input.spaceId,
        assignedBy: input.actor.kind,
        confidence: input.confidence ?? null,
        pinned: input.pinned,
        turnId: input.turnId ?? null,
        assignedAt: new Date(),
      };
      await tx
        .insert(juniorConversationSpaces)
        .values({ conversationId, ...values })
        .onConflictDoUpdate({
          target: juniorConversationSpaces.conversationId,
          set: values,
        });
      await appendChange(tx, {
        kind: "assign",
        spaceId: input.spaceId,
        conversationId,
        actor: input.actor,
        ...(input.reason ? { reason: input.reason } : undefined),
        before: { spaceId: previous?.spaceId ?? null },
        after: {
          spaceId: input.spaceId,
          pinned: input.pinned,
          ...(input.confidence !== undefined
            ? { confidence: input.confidence }
            : undefined),
        },
      });
      assigned.push(conversationId);
    }
    return { assigned, skipped };
  });
}

/** One Conversation shown in a Space. */
export interface SpaceConversation {
  conversationId: string;
  spaceId: string;
  title?: string;
  channelName?: string;
  summary?: string;
  lastActivityAtMs: number;
}

/**
 * List public Conversations assigned to a set of Spaces, newest first, and
 * count the private ones. Private content never leaves this function.
 */
export async function listSpaceConversations(
  db: Db,
  input: { spaceIds: readonly string[]; limit: number },
): Promise<{ conversations: SpaceConversation[]; privateCount: number }> {
  if (input.spaceIds.length === 0) {
    return { conversations: [], privateCount: 0 };
  }
  const briefs = juniorConversationBriefs;
  const newer = alias(juniorConversationBriefs, "newer_space_briefs");
  const inSpaces = inArray(juniorConversationSpaces.spaceId, [
    ...input.spaceIds,
  ]);
  const [rows, privateRows] = await Promise.all([
    db
      .select({
        conversationId: juniorConversations.conversationId,
        spaceId: juniorConversationSpaces.spaceId,
        title: juniorConversations.title,
        channelName: juniorConversations.channelName,
        lastActivityAt: juniorConversations.lastActivityAt,
        summary: sql<string | null>`${briefs.content}->>'summary'`,
      })
      .from(juniorConversationSpaces)
      .innerJoin(
        juniorConversations,
        eq(
          juniorConversations.conversationId,
          juniorConversationSpaces.conversationId,
        ),
      )
      .innerJoin(
        juniorDestinations,
        eq(juniorDestinations.id, juniorConversations.destinationId),
      )
      .leftJoin(
        briefs,
        and(
          eq(briefs.conversationId, juniorConversations.conversationId),
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
        ),
      )
      .where(and(inSpaces, eq(juniorDestinations.visibility, "public")))
      .orderBy(
        desc(juniorConversations.lastActivityAt),
        desc(juniorConversations.conversationId),
      )
      .limit(input.limit),
    db
      .select({ total: count() })
      .from(juniorConversationSpaces)
      .innerJoin(
        juniorConversations,
        eq(
          juniorConversations.conversationId,
          juniorConversationSpaces.conversationId,
        ),
      )
      .leftJoin(
        juniorDestinations,
        eq(juniorDestinations.id, juniorConversations.destinationId),
      )
      .where(
        and(
          inSpaces,
          sql`coalesce(${juniorDestinations.visibility}, 'private') <> 'public'`,
        ),
      ),
  ]);
  return {
    conversations: rows.map((row) => ({
      conversationId: row.conversationId,
      spaceId: row.spaceId,
      ...(row.title ? { title: row.title } : undefined),
      ...(row.channelName ? { channelName: row.channelName } : undefined),
      ...(row.summary ? { summary: row.summary } : undefined),
      lastActivityAtMs: row.lastActivityAt.getTime(),
    })),
    privateCount: Number(privateRows[0]?.total ?? 0),
  };
}

/** Resolve a merged Space id to the active Space that absorbed it. */
export async function resolveSpaceId(
  db: Db,
  spaceId: string,
): Promise<string | undefined> {
  let current = spaceId;
  for (let hops = 0; hops < 20; hops += 1) {
    const rows = await db
      .select({
        status: juniorSpaces.status,
        mergedIntoSpaceId: juniorSpaces.mergedIntoSpaceId,
      })
      .from(juniorSpaces)
      .where(eq(juniorSpaces.spaceId, current))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    if (row.status === "active") return current;
    if (row.status !== "merged" || !row.mergedIntoSpaceId) return undefined;
    current = row.mergedIntoSpaceId;
  }
  return undefined;
}
