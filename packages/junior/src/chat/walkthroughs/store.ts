/**
 * Walkthrough versions: a row per generation in SQL, and the document in
 * attachment object storage under `walkthroughs/`. The row finds the document, keeps lineage, and lets a
 * second click on an unchanged stack reuse the running or finished version.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, eq, lt, ne, sql } from "drizzle-orm";
import type { AttachmentStorage } from "@/chat/attachments/storage";
import { getDb } from "@/chat/db";
import {
  juniorConversationMetrics,
  juniorWalkthroughVersions,
} from "@/db/schema";
import type { WalkthroughCodeChange } from "@/db/schema/walkthroughs";
import { walkthroughDocumentSchema, type WalkthroughDocument } from "./schema";

export type WalkthroughVersion = typeof juniorWalkthroughVersions.$inferSelect;

/** A generation that runs longer than this died, such as in a crash. */
const GENERATION_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Key of one stack at its commits. The same code changes at the same commits
 * always give the same key.
 */
export function walkthroughSnapshotKey(
  codeChanges: readonly WalkthroughCodeChange[],
): string {
  const parts = codeChanges.map(
    (change) => `${change.number}:${change.baseSha}:${change.headSha}`,
  );
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

/** The generating or ready version for a snapshot, if any. */
async function findLiveWalkthroughVersion(input: {
  provider: string;
  repository: string;
  snapshotKey: string;
}): Promise<WalkthroughVersion | undefined> {
  const [row] = await getDb()
    .select()
    .from(juniorWalkthroughVersions)
    .where(
      and(
        eq(juniorWalkthroughVersions.provider, input.provider),
        eq(juniorWalkthroughVersions.repository, input.repository),
        eq(juniorWalkthroughVersions.snapshotKey, input.snapshotKey),
        ne(juniorWalkthroughVersions.status, "failed"),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Start a version for a snapshot. When another request already started one,
 * return that version instead, so concurrent clicks never generate twice.
 */
export async function startWalkthroughVersion(input: {
  provider: string;
  repository: string;
  codeChanges: WalkthroughCodeChange[];
  generationConversationId: string;
  sourceConversationId?: string;
  parentVersionId?: string;
  createdByUserId?: string;
}): Promise<{ version: WalkthroughVersion; started: boolean }> {
  const snapshotKey = walkthroughSnapshotKey(input.codeChanges);
  // A dead generation must not block every later click on this snapshot.
  await getDb()
    .update(juniorWalkthroughVersions)
    .set({
      status: "failed",
      failureReason: "Generation timed out.",
      completedAt: new Date(),
    })
    .where(
      and(
        eq(juniorWalkthroughVersions.provider, input.provider),
        eq(juniorWalkthroughVersions.repository, input.repository),
        eq(juniorWalkthroughVersions.snapshotKey, snapshotKey),
        eq(juniorWalkthroughVersions.status, "generating"),
        lt(
          juniorWalkthroughVersions.createdAt,
          new Date(Date.now() - GENERATION_TIMEOUT_MS),
        ),
      ),
    );
  const [row] = await getDb()
    .insert(juniorWalkthroughVersions)
    .values({
      id: randomUUID(),
      provider: input.provider,
      repository: input.repository,
      snapshotKey,
      codeChanges: input.codeChanges,
      generationConversationId: input.generationConversationId,
      sourceConversationId: input.sourceConversationId ?? null,
      parentVersionId: input.parentVersionId ?? null,
      createdByUserId: input.createdByUserId ?? null,
      status: "generating",
      createdAt: new Date(),
    })
    .onConflictDoNothing()
    .returning();
  if (row) return { version: row, started: true };
  const live = await findLiveWalkthroughVersion({ ...input, snapshotKey });
  if (!live) {
    throw new Error("Walkthrough version conflict without a live version");
  }
  return { version: live, started: false };
}

/** Read one version row by id. */
export async function getWalkthroughVersion(
  id: string,
): Promise<WalkthroughVersion | undefined> {
  const [row] = await getDb()
    .select()
    .from(juniorWalkthroughVersions)
    .where(eq(juniorWalkthroughVersions.id, id))
    .limit(1);
  return row;
}

/** The version that a generation Conversation is still generating, if any. */
export async function getGeneratingWalkthroughVersion(
  generationConversationId: string,
): Promise<WalkthroughVersion | undefined> {
  const [row] = await getDb()
    .select()
    .from(juniorWalkthroughVersions)
    .where(
      and(
        eq(
          juniorWalkthroughVersions.generationConversationId,
          generationConversationId,
        ),
        eq(juniorWalkthroughVersions.status, "generating"),
      ),
    )
    .limit(1);
  return row;
}

/** What a version's generation Conversation has cost so far. */
export async function readWalkthroughCostUsd(
  version: Pick<WalkthroughVersion, "generationConversationId">,
): Promise<number | undefined> {
  if (!version.generationConversationId) return undefined;
  const [row] = await getDb()
    .select({
      total: sql<number | null>`sum(${juniorConversationMetrics.value})`,
    })
    .from(juniorConversationMetrics)
    .where(
      and(
        eq(
          juniorConversationMetrics.conversationId,
          version.generationConversationId,
        ),
        eq(juniorConversationMetrics.metric, "cost_usd"),
      ),
    );
  return row?.total ?? undefined;
}

/**
 * Store the document of a generating version and mark it ready. Returns
 * false when the version is no longer generating, such as after a failure.
 */
export async function completeWalkthroughVersion(
  storage: AttachmentStorage,
  input: { id: string; document: WalkthroughDocument },
): Promise<boolean> {
  const document = walkthroughDocumentSchema.parse(input.document);
  const documentKey = `walkthroughs/${input.id}.json`;
  await storage.put({
    key: documentKey,
    contentType: "application/json",
    body: Buffer.from(JSON.stringify(document)),
  });
  const updated = await getDb()
    .update(juniorWalkthroughVersions)
    .set({
      status: "ready",
      documentKey,
      completedAt: new Date(),
    })
    .where(
      and(
        eq(juniorWalkthroughVersions.id, input.id),
        eq(juniorWalkthroughVersions.status, "generating"),
      ),
    )
    .returning({ id: juniorWalkthroughVersions.id });
  return updated.length > 0;
}

/** Mark a generating version failed, so the next click can retry. */
export async function failWalkthroughVersion(input: {
  id: string;
  reason: string;
}): Promise<void> {
  await getDb()
    .update(juniorWalkthroughVersions)
    .set({
      status: "failed",
      failureReason: input.reason,
      completedAt: new Date(),
    })
    .where(
      and(
        eq(juniorWalkthroughVersions.id, input.id),
        eq(juniorWalkthroughVersions.status, "generating"),
      ),
    );
}

/** Read the stored document of a ready version. */
export async function readWalkthroughDocument(
  storage: AttachmentStorage,
  version: Pick<WalkthroughVersion, "documentKey">,
): Promise<WalkthroughDocument | undefined> {
  if (!version.documentKey) return undefined;
  const stream = await storage.get(version.documentKey);
  if (!stream) return undefined;
  const text = await new Response(stream).text();
  return walkthroughDocumentSchema.parse(JSON.parse(text));
}
