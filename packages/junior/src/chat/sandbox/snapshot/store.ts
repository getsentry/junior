import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, ne, or } from "drizzle-orm";
import { getSqlExecutor } from "@/chat/db";
import { logException } from "@/chat/logging";
import { deleteWorkspaceSnapshotBuilders } from "@/chat/sandbox/snapshot/builder-sandbox";
import type { JuniorDatabase } from "@/db/db";
import { juniorSnapshots } from "@/db/schema";
import type {
  WorkspaceSnapshot,
  WorkspaceSnapshotBuild,
} from "@/chat/workspaces/types";

type SnapshotRow = typeof juniorSnapshots.$inferSelect;

/** Current ready artifact and build state for one Workspace profile. */
export interface WorkspaceSnapshots {
  ready: WorkspaceSnapshot | null;
  build: WorkspaceSnapshotBuild | null;
}

/** Result of replacing the ready snapshot for one Workspace profile. */
export interface WorkspaceSnapshotWriteResult {
  written: boolean;
  replacedBuilderNames: string[];
}

function builderNames(rows: Array<{ sandboxName: string | null }>): string[] {
  return [
    ...new Set(
      rows
        .map((row) => row.sandboxName)
        .filter((name): name is string => Boolean(name)),
    ),
  ];
}

function snapshotFromRow(row: SnapshotRow): WorkspaceSnapshot {
  if (
    row.status !== "ready" ||
    !row.snapshotId ||
    !row.generatedAt ||
    row.buildDurationMs == null
  ) {
    throw new Error(`Invalid ready Workspace snapshot row: ${row.id}`);
  }
  return {
    id: row.snapshotId,
    generatedAt: row.generatedAt,
    buildDurationMs: row.buildDurationMs,
    profileHash: row.profileHash,
  };
}

function snapshotBuildFromRow(row: SnapshotRow): WorkspaceSnapshotBuild {
  if (row.status === "ready" || !row.buildStartedAt || !row.buildPhase) {
    throw new Error(`Invalid Workspace snapshot build row: ${row.id}`);
  }
  return {
    id: row.id,
    status: row.status,
    phase: row.buildPhase,
    profileHash: row.profileHash,
    startedAt: row.buildStartedAt,
    sandboxName: row.buildSandboxName,
    commandId: row.buildCommandId,
    error: row.buildError,
  };
}

/** Load bounded ready and build views for one Workspace profile hash. */
export async function loadSnapshotsForProfile(
  db: JuniorDatabase,
  workspaceId: string,
  profileHash: string,
): Promise<WorkspaceSnapshots> {
  const profile = and(
    eq(juniorSnapshots.workspaceId, workspaceId),
    eq(juniorSnapshots.profileHash, profileHash),
  );
  const order = [
    desc(juniorSnapshots.updatedAt),
    desc(juniorSnapshots.createdAt),
    desc(juniorSnapshots.id),
  ] as const;
  const [readyRows, buildRows] = await Promise.all([
    db
      .select()
      .from(juniorSnapshots)
      .where(and(profile, eq(juniorSnapshots.status, "ready")))
      .orderBy(...order)
      .limit(1),
    db
      .select()
      .from(juniorSnapshots)
      .where(and(profile, ne(juniorSnapshots.status, "ready")))
      .orderBy(asc(juniorSnapshots.status), ...order)
      .limit(1),
  ]);
  return {
    ready: readyRows[0] ? snapshotFromRow(readyRows[0]) : null,
    build: buildRows[0] ? snapshotBuildFromRow(buildRows[0]) : null,
  };
}

/** Drop every snapshot row before its Workspace is deleted. */
export async function clearWorkspaceSnapshots(
  db: JuniorDatabase,
  workspaceId: string,
): Promise<string[]> {
  const deleted = await db
    .delete(juniorSnapshots)
    .where(eq(juniorSnapshots.workspaceId, workspaceId))
    .returning({ sandboxName: juniorSnapshots.buildSandboxName });
  return builderNames(deleted);
}

/** Drop one ready snapshot and return the name of its provider owner. */
export async function invalidateReadySnapshot(params: {
  workspaceId: string;
  profileHash: string;
  snapshotId: string;
}): Promise<string | null> {
  const executor = getSqlExecutor();
  return await executor.transaction(async () => {
    const db = executor.db();
    const deleted = await db
      .delete(juniorSnapshots)
      .where(
        and(
          eq(juniorSnapshots.workspaceId, params.workspaceId),
          eq(juniorSnapshots.profileHash, params.profileHash),
          eq(juniorSnapshots.status, "ready"),
          eq(juniorSnapshots.snapshotId, params.snapshotId),
        ),
      )
      .returning({ sandboxName: juniorSnapshots.buildSandboxName });
    return deleted[0]?.sandboxName ?? null;
  });
}

/** Record one ready snapshot and report provider owners that it replaced. */
export async function setWorkspaceSnapshot(
  workspaceId: string,
  snapshot: WorkspaceSnapshot,
  options: { buildId?: string } = {},
): Promise<WorkspaceSnapshotWriteResult> {
  const executor = getSqlExecutor();
  return await executor.transaction(async () => {
    const db = executor.db();
    const now = new Date();
    if (options.buildId) {
      const updated = await db
        .update(juniorSnapshots)
        .set({
          status: "ready",
          snapshotId: snapshot.id,
          buildDurationMs: snapshot.buildDurationMs,
          generatedAt: snapshot.generatedAt,
          buildStartedAt: null,
          buildPhase: null,
          buildCommandId: null,
          buildError: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(juniorSnapshots.id, options.buildId),
            eq(juniorSnapshots.workspaceId, workspaceId),
            eq(juniorSnapshots.profileHash, snapshot.profileHash),
            eq(juniorSnapshots.status, "building"),
          ),
        )
        .returning({ id: juniorSnapshots.id });
      if (updated.length === 0) {
        return { written: false, replacedBuilderNames: [] };
      }
      const replaced = await db
        .delete(juniorSnapshots)
        .where(
          and(
            eq(juniorSnapshots.workspaceId, workspaceId),
            eq(juniorSnapshots.profileHash, snapshot.profileHash),
            ne(juniorSnapshots.id, options.buildId),
            or(
              eq(juniorSnapshots.status, "failed"),
              eq(juniorSnapshots.status, "ready"),
            ),
          ),
        )
        .returning({ sandboxName: juniorSnapshots.buildSandboxName });
      return {
        written: true,
        replacedBuilderNames: builderNames(replaced),
      };
    }

    const existing = await db
      .select()
      .from(juniorSnapshots)
      .where(
        and(
          eq(juniorSnapshots.workspaceId, workspaceId),
          eq(juniorSnapshots.profileHash, snapshot.profileHash),
          eq(juniorSnapshots.status, "ready"),
          eq(juniorSnapshots.snapshotId, snapshot.id),
        ),
      )
      .orderBy(desc(juniorSnapshots.updatedAt), desc(juniorSnapshots.createdAt))
      .limit(1);
    const current = existing[0];

    if (current) {
      await db
        .update(juniorSnapshots)
        .set({
          buildDurationMs: snapshot.buildDurationMs,
          generatedAt: snapshot.generatedAt,
          buildStartedAt: null,
          buildPhase: null,
          buildCommandId: null,
          buildError: null,
          updatedAt: now,
        })
        .where(eq(juniorSnapshots.id, current.id));
      return { written: true, replacedBuilderNames: [] };
    }

    const replaced = await db
      .delete(juniorSnapshots)
      .where(
        and(
          eq(juniorSnapshots.workspaceId, workspaceId),
          eq(juniorSnapshots.profileHash, snapshot.profileHash),
          eq(juniorSnapshots.status, "ready"),
        ),
      )
      .returning({ sandboxName: juniorSnapshots.buildSandboxName });

    // Build rows have immutable owners. Record an independently resolved
    // snapshot in its own ready row instead of changing active build state.
    await db.insert(juniorSnapshots).values({
      id: randomUUID(),
      workspaceId,
      profileHash: snapshot.profileHash,
      status: "ready",
      snapshotId: snapshot.id,
      buildDurationMs: snapshot.buildDurationMs,
      generatedAt: snapshot.generatedAt,
      buildStartedAt: null,
      buildSandboxName: null,
      buildCommandId: null,
      buildError: null,
      createdAt: now,
      updatedAt: now,
    });
    return {
      written: true,
      replacedBuilderNames: builderNames(replaced),
    };
  });
}

/** Update an owned build row. Initial creation must opt into insertion. */
export async function setWorkspaceSnapshotBuild(
  workspaceId: string,
  build: WorkspaceSnapshotBuild,
  options: { insertIfMissing?: boolean } = {},
): Promise<boolean> {
  const executor = getSqlExecutor();
  return await executor.transaction(async () => {
    const db = executor.db();
    const now = new Date();
    const updated = await db
      .update(juniorSnapshots)
      .set({
        status: build.status,
        buildStartedAt: build.startedAt,
        buildPhase: build.phase,
        buildSandboxName: build.sandboxName,
        buildCommandId: build.commandId,
        buildError: build.error,
        updatedAt: now,
      })
      .where(
        and(
          eq(juniorSnapshots.id, build.id),
          eq(juniorSnapshots.workspaceId, workspaceId),
          eq(juniorSnapshots.profileHash, build.profileHash),
          eq(juniorSnapshots.status, "building"),
        ),
      )
      .returning({ id: juniorSnapshots.id });
    if (updated.length > 0) {
      return true;
    }
    if (!options.insertIfMissing) return false;

    // Terminal rows are immutable. A new build gets its own id and row.
    const inserted = await db
      .insert(juniorSnapshots)
      .values({
        id: build.id,
        workspaceId,
        profileHash: build.profileHash,
        status: build.status,
        snapshotId: null,
        buildDurationMs: null,
        generatedAt: null,
        buildStartedAt: build.startedAt,
        buildPhase: build.phase,
        buildSandboxName: build.sandboxName,
        buildCommandId: build.commandId,
        buildError: build.error,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: juniorSnapshots.id });
    return inserted.length > 0;
  });
}

/** Persist Workspace snapshot facts when resolve returns a concrete entry. */
export async function recordResolvedWorkspaceSnapshot(
  workspaceId: string,
  snapshot: {
    snapshotId?: string;
    profileHash?: string;
    createdAtMs?: number;
    buildDurationMs?: number;
  },
): Promise<void> {
  if (
    !snapshot.snapshotId ||
    !snapshot.profileHash ||
    snapshot.createdAtMs == null ||
    snapshot.buildDurationMs == null
  ) {
    return;
  }
  let result: WorkspaceSnapshotWriteResult;
  try {
    result = await setWorkspaceSnapshot(workspaceId, {
      id: snapshot.snapshotId,
      generatedAt: new Date(snapshot.createdAtMs),
      buildDurationMs: snapshot.buildDurationMs,
      profileHash: snapshot.profileHash,
    });
  } catch (error) {
    // Dashboard enrichment must not fail a prepared Workspace Sandbox.
    logException(error, "sandbox.workspace_snapshot.persist.failed", {
      "app.workspace.id": workspaceId,
    });
    return;
  }
  try {
    await deleteWorkspaceSnapshotBuilders(result.replacedBuilderNames);
  } catch (error) {
    logException(error, "sandbox.workspace_snapshot.builder.delete_failed", {
      "app.workspace.id": workspaceId,
      "app.sandbox.snapshot.builder_count": result.replacedBuilderNames.length,
    });
  }
}
