import { and, asc, desc, eq, ne, or } from "drizzle-orm";
import { getSqlExecutor } from "@/chat/db";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorSnapshots,
  juniorWorkspaceRepos,
  juniorWorkspaces,
} from "@/db/schema";
import type {
  Workspace,
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

function sameWorkspaceRecipe(
  stored: {
    setupScript: string;
    repos: Array<{ provider: string; repo: string }>;
  },
  expected: Pick<Workspace, "setupScript" | "repos">,
): boolean {
  if (
    stored.setupScript !== expected.setupScript ||
    stored.repos.length !== expected.repos.length
  ) {
    return false;
  }
  const expectedRepos = new Set(
    expected.repos.map((repo) => JSON.stringify([repo.provider, repo.repo])),
  );
  return stored.repos.every((repo) =>
    expectedRepos.has(JSON.stringify([repo.provider, repo.repo])),
  );
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
    sizeBytes: row.sizeBytes,
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
  // Serialize snapshot cleanup with initial build insertion. This ensures a
  // concurrent recipe write or delete collects every recorded builder owner.
  await db
    .select({ id: juniorWorkspaces.id })
    .from(juniorWorkspaces)
    .where(eq(juniorWorkspaces.id, workspaceId))
    .for("update");
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

/** Complete one owned build and report provider owners that it replaced. */
export async function setWorkspaceSnapshot(
  workspaceId: string,
  snapshot: WorkspaceSnapshot,
  options: { buildId: string },
): Promise<WorkspaceSnapshotWriteResult> {
  const executor = getSqlExecutor();
  return await executor.transaction(async () => {
    const db = executor.db();
    const now = new Date();
    const updated = await db
      .update(juniorSnapshots)
      .set({
        status: "ready",
        snapshotId: snapshot.id,
        buildDurationMs: snapshot.buildDurationMs,
        sizeBytes: snapshot.sizeBytes,
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
  });
}

/** Update an owned build row. Initial creation locks and verifies its Workspace. */
export async function setWorkspaceSnapshotBuild(
  workspaceId: string,
  build: WorkspaceSnapshotBuild,
  options: {
    insertIfMissing?: boolean;
    expectedRecipe?: Pick<Workspace, "setupScript" | "repos">;
  } = {},
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

    const workspaceRows = await db
      .select({ setupScript: juniorWorkspaces.setupScript })
      .from(juniorWorkspaces)
      .where(eq(juniorWorkspaces.id, workspaceId))
      .for("update");
    const workspace = workspaceRows[0];
    if (!workspace) return false;
    if (options.expectedRecipe) {
      const repos = await db
        .select({
          provider: juniorWorkspaceRepos.provider,
          repo: juniorWorkspaceRepos.repo,
        })
        .from(juniorWorkspaceRepos)
        .where(eq(juniorWorkspaceRepos.workspaceId, workspaceId));
      if (
        !sameWorkspaceRecipe({ ...workspace, repos }, options.expectedRecipe)
      ) {
        return false;
      }
    }

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
        sizeBytes: null,
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
