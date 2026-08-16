import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { getSqlExecutor } from "@/chat/db";
import { logException } from "@/chat/logging";
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
} from "./types";
import {
  normalizeWorkspaceRecipe,
  WorkspaceValidationError,
  type WorkspaceRecipeInput,
} from "./validation";

type SnapshotRow = typeof juniorSnapshots.$inferSelect;

function snapshotFromRow(row: SnapshotRow | undefined): WorkspaceSnapshot | null {
  if (
    !row ||
    row.status !== "ready" ||
    !row.snapshotId ||
    !row.generatedAt ||
    row.buildDurationMs == null ||
    !row.runtime ||
    row.dependencyCount == null
  ) {
    return null;
  }
  return {
    id: row.snapshotId,
    generatedAt: row.generatedAt,
    buildDurationMs: row.buildDurationMs,
    profileHash: row.profileHash,
    runtime: row.runtime,
    dependencyCount: row.dependencyCount,
  };
}

function snapshotBuildFromRow(
  row: SnapshotRow | undefined,
): WorkspaceSnapshotBuild | null {
  if (!row || !row.buildStartedAt) return null;
  return {
    status: row.status,
    profileHash: row.profileHash,
    startedAt: row.buildStartedAt,
    sandboxName: row.buildSandboxName,
    commandId: row.buildCommandId,
    error: row.buildError,
  };
}

type WorkspaceSnapshotRows = {
  ready: SnapshotRow | undefined;
  build: SnapshotRow | undefined;
};

function workspaceFromRows(
  row: typeof juniorWorkspaces.$inferSelect,
  repos: Array<typeof juniorWorkspaceRepos.$inferSelect>,
  snapshots: WorkspaceSnapshotRows,
): Workspace {
  return {
    id: row.id,
    name: row.name,
    setupScript: row.setupScript,
    repos: repos.map((repo) => ({
      provider: repo.provider,
      repo: repo.repo,
    })),
    snapshot: snapshotFromRow(snapshots.ready),
    snapshotBuild: snapshotBuildFromRow(snapshots.build),
  };
}

async function loadWorkspaceRepos(
  db: JuniorDatabase,
  workspaceId: string,
): Promise<Array<typeof juniorWorkspaceRepos.$inferSelect>> {
  return await db
    .select()
    .from(juniorWorkspaceRepos)
    .where(eq(juniorWorkspaceRepos.workspaceId, workspaceId))
    .orderBy(
      asc(juniorWorkspaceRepos.provider),
      asc(juniorWorkspaceRepos.repo),
    );
}

function emptySnapshotRows(): WorkspaceSnapshotRows {
  return { ready: undefined, build: undefined };
}

function collectSnapshotRows(rows: SnapshotRow[]): WorkspaceSnapshotRows {
  const result = emptySnapshotRows();
  for (const row of rows) {
    if (!result.ready && row.status === "ready") {
      result.ready = row;
    }
    if (!result.build && row.status !== "ready") {
      result.build = row;
    }
    if (result.ready && result.build) break;
  }
  return result;
}

/** Latest ready artifact and latest in-flight/failed build per workspace. */
async function loadLatestSnapshotsByWorkspace(
  db: JuniorDatabase,
  workspaceIds: string[],
): Promise<Map<string, WorkspaceSnapshotRows>> {
  const byWorkspace = new Map<string, WorkspaceSnapshotRows>();
  if (workspaceIds.length === 0) return byWorkspace;
  const rows = await db
    .select()
    .from(juniorSnapshots)
    .where(inArray(juniorSnapshots.workspaceId, workspaceIds))
    .orderBy(desc(juniorSnapshots.updatedAt), desc(juniorSnapshots.createdAt));
  const grouped = new Map<string, SnapshotRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.workspaceId);
    if (list) list.push(row);
    else grouped.set(row.workspaceId, [row]);
  }
  for (const workspaceId of workspaceIds) {
    byWorkspace.set(
      workspaceId,
      collectSnapshotRows(grouped.get(workspaceId) ?? []),
    );
  }
  return byWorkspace;
}

async function loadLatestSnapshots(
  db: JuniorDatabase,
  workspaceId: string,
): Promise<WorkspaceSnapshotRows> {
  const rows = await db
    .select()
    .from(juniorSnapshots)
    .where(eq(juniorSnapshots.workspaceId, workspaceId))
    .orderBy(desc(juniorSnapshots.updatedAt), desc(juniorSnapshots.createdAt));
  return collectSnapshotRows(rows);
}

async function replaceWorkspaceRepos(
  db: JuniorDatabase,
  workspaceId: string,
  repos: WorkspaceRecipeInput["repos"],
): Promise<void> {
  await db
    .delete(juniorWorkspaceRepos)
    .where(eq(juniorWorkspaceRepos.workspaceId, workspaceId));
  if (repos.length === 0) return;
  await db.insert(juniorWorkspaceRepos).values(
    repos.map((repo) => ({
      workspaceId,
      provider: repo.provider,
      repo: repo.repo,
    })),
  );
}

function sameWorkspaceRepos(
  current: Workspace["repos"],
  next: WorkspaceRecipeInput["repos"],
): boolean {
  if (current.length !== next.length) return false;
  const identity = (repo: Workspace["repos"][number]) =>
    `${repo.provider}:${repo.repo.toLowerCase()}`;
  const currentIds = current.map(identity).sort();
  const nextIds = next.map(identity).sort();
  return currentIds.every((value, index) => value === nextIds[index]);
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 6; depth += 1) {
    if (
      typeof current === "object" &&
      current !== null &&
      "code" in current &&
      (current as { code?: unknown }).code === "23505"
    ) {
      return true;
    }
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return false;
}

/** List Workspace recipes by stable name. */
export async function listWorkspaces(db: JuniorDatabase): Promise<Workspace[]> {
  const [workspaces, repos] = await Promise.all([
    db.select().from(juniorWorkspaces).orderBy(asc(juniorWorkspaces.name)),
    db
      .select()
      .from(juniorWorkspaceRepos)
      .orderBy(
        asc(juniorWorkspaceRepos.workspaceId),
        asc(juniorWorkspaceRepos.provider),
        asc(juniorWorkspaceRepos.repo),
      ),
  ]);
  const snapshots = await loadLatestSnapshotsByWorkspace(
    db,
    workspaces.map((workspace) => workspace.id),
  );
  return workspaces.map((workspace) =>
    workspaceFromRows(
      workspace,
      repos.filter((repo) => repo.workspaceId === workspace.id),
      snapshots.get(workspace.id) ?? emptySnapshotRows(),
    ),
  );
}

/** Find Workspace names that include one provider repository. */
export async function listWorkspaceNamesByRepository(
  db: JuniorDatabase,
  input: { provider: string; repo: string },
): Promise<string[]> {
  const provider = input.provider.trim().toLowerCase();
  const repo = input.repo.trim();
  const rows = await db
    .select({ name: juniorWorkspaces.name })
    .from(juniorWorkspaceRepos)
    .innerJoin(
      juniorWorkspaces,
      eq(juniorWorkspaces.id, juniorWorkspaceRepos.workspaceId),
    )
    .where(
      and(
        eq(juniorWorkspaceRepos.provider, provider),
        // Recipes store the provided repo casing; identity is case-insensitive.
        sql`lower(${juniorWorkspaceRepos.repo}) = lower(${repo})`,
      ),
    )
    .orderBy(asc(juniorWorkspaces.name));
  return rows.map((row) => row.name);
}

/** Resolve one Workspace recipe by name. */
export async function getWorkspaceByName(
  db: JuniorDatabase,
  name: string,
): Promise<Workspace | undefined> {
  const rows = await db
    .select()
    .from(juniorWorkspaces)
    .where(eq(juniorWorkspaces.name, name))
    .limit(1);
  const workspace = rows[0];
  if (!workspace) return undefined;
  return workspaceFromRows(
    workspace,
    await loadWorkspaceRepos(db, workspace.id),
    await loadLatestSnapshots(db, workspace.id),
  );
}

/** Resolve one Workspace recipe by id. */
export async function getWorkspace(
  db: JuniorDatabase,
  id: string,
): Promise<Workspace | undefined> {
  const rows = await db
    .select()
    .from(juniorWorkspaces)
    .where(eq(juniorWorkspaces.id, id))
    .limit(1);
  const workspace = rows[0];
  if (!workspace) return undefined;
  return workspaceFromRows(
    workspace,
    await loadWorkspaceRepos(db, workspace.id),
    await loadLatestSnapshots(db, workspace.id),
  );
}

/** Create one install-wide Workspace recipe. */
export async function createWorkspace(input: {
  name: string;
  setupScript?: string;
  repos: Array<{
    provider: string;
    repo: string;
  }>;
}): Promise<Workspace> {
  const recipe = normalizeWorkspaceRecipe(input);
  const executor = getSqlExecutor();
  const now = new Date();
  const id = randomUUID();

  try {
    await executor.transaction(async () => {
      const db = executor.db();
      await db.insert(juniorWorkspaces).values({
        id,
        name: recipe.name,
        setupScript: recipe.setupScript,
        createdAt: now,
        updatedAt: now,
      });
      await replaceWorkspaceRepos(db, id, recipe.repos);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new WorkspaceValidationError(
        `Workspace name already exists: ${recipe.name}`,
      );
    }
    throw error;
  }

  return (await getWorkspace(executor.db(), id))!;
}

/** Replace one install-wide Workspace recipe. */
export async function updateWorkspace(
  id: string,
  input: {
    name: string;
    setupScript?: string;
    repos: Array<{
      provider: string;
      repo: string;
    }>;
  },
): Promise<Workspace | undefined> {
  const recipe = normalizeWorkspaceRecipe(input);
  const executor = getSqlExecutor();
  const now = new Date();

  try {
    const updated = await executor.transaction(async () => {
      const db = executor.db();
      const existingRows = await db
        .select()
        .from(juniorWorkspaces)
        .where(eq(juniorWorkspaces.id, id))
        .limit(1);
      const existing = existingRows[0];
      if (!existing) return undefined;
      const existingRepos = await loadWorkspaceRepos(db, id);
      const snapshotChanged =
        existing.setupScript !== recipe.setupScript ||
        !sameWorkspaceRepos(existingRepos, recipe.repos);
      const rows = await db
        .update(juniorWorkspaces)
        .set({
          name: recipe.name,
          setupScript: recipe.setupScript,
          updatedAt: now,
        })
        .where(eq(juniorWorkspaces.id, id))
        .returning();
      await replaceWorkspaceRepos(db, id, recipe.repos);
      if (snapshotChanged) {
        // Drop in-flight/failed rows for the old recipe. Keep ready rows so
        // their Vercel snapshot ids remain available for later GC.
        // TODO: garbage-collect retired Vercel snapshots once retention policy exists.
        await db
          .delete(juniorSnapshots)
          .where(
            and(
              eq(juniorSnapshots.workspaceId, id),
              ne(juniorSnapshots.status, "ready"),
            ),
          );
      }
      return rows[0];
    });
    if (!updated) return undefined;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new WorkspaceValidationError(
        `Workspace name already exists: ${recipe.name}`,
      );
    }
    throw error;
  }

  return await getWorkspace(executor.db(), id);
}

/** Delete one install-wide Workspace recipe. */
export async function deleteWorkspace(id: string): Promise<boolean> {
  const executor = getSqlExecutor();
  return await executor.transaction(async () => {
    const rows = await executor
      .db()
      .delete(juniorWorkspaces)
      .where(eq(juniorWorkspaces.id, id))
      .returning({ id: juniorWorkspaces.id });
    return rows.length > 0;
  });
}

/** Record the full Sandbox snapshot after a successful Workspace prepare. */
export async function setWorkspaceSnapshot(
  workspaceId: string,
  snapshot: WorkspaceSnapshot,
): Promise<void> {
  const executor = getSqlExecutor();
  await executor.transaction(async () => {
    const db = executor.db();
    const workspaceRows = await db
      .select({ id: juniorWorkspaces.id })
      .from(juniorWorkspaces)
      .where(eq(juniorWorkspaces.id, workspaceId))
      .limit(1);
    if (!workspaceRows[0]) return;

    const now = new Date();
    const existing = await db
      .select()
      .from(juniorSnapshots)
      .where(
        and(
          eq(juniorSnapshots.workspaceId, workspaceId),
          eq(juniorSnapshots.profileHash, snapshot.profileHash),
        ),
      )
      .orderBy(desc(juniorSnapshots.updatedAt), desc(juniorSnapshots.createdAt))
      .limit(1);
    const current = existing[0];

    // Keep prior ready rows with different snapshot ids for later GC.
    // TODO: garbage-collect retired Vercel snapshots once retention policy exists.
    if (current && current.status !== "ready") {
      await db
        .update(juniorSnapshots)
        .set({
          status: "ready",
          snapshotId: snapshot.id,
          runtime: snapshot.runtime,
          dependencyCount: snapshot.dependencyCount,
          buildDurationMs: snapshot.buildDurationMs,
          generatedAt: snapshot.generatedAt,
          buildSandboxName: null,
          buildCommandId: null,
          buildError: null,
          updatedAt: now,
        })
        .where(eq(juniorSnapshots.id, current.id));
      return;
    }

    if (
      current &&
      current.status === "ready" &&
      current.snapshotId === snapshot.id
    ) {
      await db
        .update(juniorSnapshots)
        .set({
          runtime: snapshot.runtime,
          dependencyCount: snapshot.dependencyCount,
          buildDurationMs: snapshot.buildDurationMs,
          generatedAt: snapshot.generatedAt,
          buildSandboxName: null,
          buildCommandId: null,
          buildError: null,
          updatedAt: now,
        })
        .where(eq(juniorSnapshots.id, current.id));
      return;
    }

    await db.insert(juniorSnapshots).values({
      id: randomUUID(),
      workspaceId,
      profileHash: snapshot.profileHash,
      status: "ready",
      snapshotId: snapshot.id,
      runtime: snapshot.runtime,
      dependencyCount: snapshot.dependencyCount,
      buildDurationMs: snapshot.buildDurationMs,
      generatedAt: snapshot.generatedAt,
      buildStartedAt: null,
      buildSandboxName: null,
      buildCommandId: null,
      buildError: null,
      createdAt: now,
      updatedAt: now,
    });
  });
}

/** Record a Workspace snapshot build that can continue outside one function invocation. */
export async function setWorkspaceSnapshotBuild(
  workspaceId: string,
  build: WorkspaceSnapshotBuild,
): Promise<void> {
  const executor = getSqlExecutor();
  await executor.transaction(async () => {
    const db = executor.db();
    const workspaceRows = await db
      .select({ id: juniorWorkspaces.id })
      .from(juniorWorkspaces)
      .where(eq(juniorWorkspaces.id, workspaceId))
      .limit(1);
    if (!workspaceRows[0]) return;

    const now = new Date();
    const existing = await db
      .select()
      .from(juniorSnapshots)
      .where(
        and(
          eq(juniorSnapshots.workspaceId, workspaceId),
          eq(juniorSnapshots.profileHash, build.profileHash),
        ),
      )
      .orderBy(desc(juniorSnapshots.updatedAt), desc(juniorSnapshots.createdAt))
      .limit(1);
    const current = existing[0];

    // Never overwrite a ready artifact row with build state. Insert a new
    // in-flight row so prior ready snapshot ids remain for GC.
    if (current && current.status !== "ready") {
      await db
        .update(juniorSnapshots)
        .set({
          status: build.status,
          buildStartedAt: build.startedAt,
          buildSandboxName: build.sandboxName,
          buildCommandId: build.commandId,
          buildError: build.error,
          updatedAt: now,
        })
        .where(eq(juniorSnapshots.id, current.id));
      return;
    }

    await db.insert(juniorSnapshots).values({
      id: randomUUID(),
      workspaceId,
      profileHash: build.profileHash,
      status: build.status,
      snapshotId: null,
      runtime: null,
      dependencyCount: null,
      buildDurationMs: null,
      generatedAt: null,
      buildStartedAt: build.startedAt,
      buildSandboxName: build.sandboxName,
      buildCommandId: build.commandId,
      buildError: build.error,
      createdAt: now,
      updatedAt: now,
    });
  });
}

/** Persist dashboard snapshot facts when resolve returned a concrete entry. */
export async function recordResolvedWorkspaceSnapshot(
  workspaceId: string,
  snapshot: {
    snapshotId?: string;
    profileHash?: string;
    createdAtMs?: number;
    buildDurationMs?: number;
    runtime?: string;
    dependencyCount?: number;
  },
): Promise<void> {
  if (
    !snapshot.snapshotId ||
    !snapshot.profileHash ||
    snapshot.createdAtMs == null ||
    snapshot.buildDurationMs == null ||
    !snapshot.runtime ||
    snapshot.dependencyCount == null
  ) {
    return;
  }
  try {
    await setWorkspaceSnapshot(workspaceId, {
      id: snapshot.snapshotId,
      generatedAt: new Date(snapshot.createdAtMs),
      buildDurationMs: snapshot.buildDurationMs,
      profileHash: snapshot.profileHash,
      runtime: snapshot.runtime,
      dependencyCount: snapshot.dependencyCount,
    });
  } catch (error) {
    // Dashboard enrichment must not fail a prepared Workspace Sandbox.
    logException(error, "sandbox.workspace_snapshot.persist.failed", {
      "app.workspace.id": workspaceId,
    });
  }
}

export { WorkspaceValidationError };
