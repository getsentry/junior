import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { getSqlExecutor } from "@/chat/db";
import { logException } from "@/chat/logging";
import type { JuniorDatabase } from "@/db/db";
import { juniorWorkspaceRepos, juniorWorkspaces } from "@/db/schema";
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

function previousSnapshotIdsFromRow(
  value: typeof juniorWorkspaces.$inferSelect.previousSnapshotIds,
): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function snapshotFromRow(
  row: typeof juniorWorkspaces.$inferSelect,
): WorkspaceSnapshot | null {
  if (
    !row.snapshotId ||
    !row.snapshotGeneratedAt ||
    row.snapshotBuildDurationMs == null ||
    !row.snapshotProfileHash ||
    !row.snapshotRuntime ||
    row.snapshotDependencyCount == null
  ) {
    return null;
  }
  return {
    id: row.snapshotId,
    generatedAt: row.snapshotGeneratedAt,
    buildDurationMs: row.snapshotBuildDurationMs,
    profileHash: row.snapshotProfileHash,
    runtime: row.snapshotRuntime,
    dependencyCount: row.snapshotDependencyCount,
    previousSnapshotIds: previousSnapshotIdsFromRow(row.previousSnapshotIds),
  };
}

function snapshotBuildFromRow(
  row: typeof juniorWorkspaces.$inferSelect,
): WorkspaceSnapshotBuild | null {
  if (
    !row.snapshotStatus ||
    !row.snapshotBuildProfileHash ||
    !row.snapshotBuildStartedAt
  ) {
    return null;
  }
  return {
    status: row.snapshotStatus,
    profileHash: row.snapshotBuildProfileHash,
    startedAt: row.snapshotBuildStartedAt,
    sandboxName: row.snapshotBuildSandboxName,
    commandId: row.snapshotBuildCommandId,
    error: row.snapshotBuildError,
  };
}

function workspaceFromRows(
  row: typeof juniorWorkspaces.$inferSelect,
  repos: Array<typeof juniorWorkspaceRepos.$inferSelect>,
): Workspace {
  return {
    id: row.id,
    name: row.name,
    setupScript: row.setupScript,
    repos: repos.map((repo) => ({
      provider: repo.provider,
      repo: repo.repo,
    })),
    snapshot: snapshotFromRow(row),
    snapshotBuild: snapshotBuildFromRow(row),
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
  return workspaces.map((workspace) =>
    workspaceFromRows(
      workspace,
      repos.filter((repo) => repo.workspaceId === workspace.id),
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
          ...(snapshotChanged
            ? {
                snapshotId: null,
                snapshotGeneratedAt: null,
                snapshotBuildDurationMs: null,
                snapshotProfileHash: null,
                snapshotRuntime: null,
                snapshotDependencyCount: null,
                // Keep prior ids for later GC; do not delete Vercel snapshots here.
                previousSnapshotIds: existing.snapshotId
                  ? [
                      ...previousSnapshotIdsFromRow(existing.previousSnapshotIds),
                      existing.snapshotId,
                    ]
                  : previousSnapshotIdsFromRow(existing.previousSnapshotIds),
                snapshotStatus: null,
                snapshotBuildProfileHash: null,
                snapshotBuildStartedAt: null,
                snapshotBuildSandboxName: null,
                snapshotBuildCommandId: null,
                snapshotBuildError: null,
              }
            : {}),
          updatedAt: now,
        })
        .where(eq(juniorWorkspaces.id, id))
        .returning();
      await replaceWorkspaceRepos(db, id, recipe.repos);
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
    const existingRows = await db
      .select({
        snapshotId: juniorWorkspaces.snapshotId,
        previousSnapshotIds: juniorWorkspaces.previousSnapshotIds,
      })
      .from(juniorWorkspaces)
      .where(eq(juniorWorkspaces.id, workspaceId))
      .limit(1);
    const existing = existingRows[0];
    if (!existing) return;

    const previousSnapshotIds = previousSnapshotIdsFromRow(
      existing.previousSnapshotIds,
    );
    // TODO: garbage-collect retired Vercel snapshots once retention policy exists.
    if (
      existing.snapshotId &&
      existing.snapshotId !== snapshot.id &&
      !previousSnapshotIds.includes(existing.snapshotId)
    ) {
      previousSnapshotIds.push(existing.snapshotId);
    }

    await db
      .update(juniorWorkspaces)
      .set({
        snapshotId: snapshot.id,
        snapshotGeneratedAt: snapshot.generatedAt,
        snapshotBuildDurationMs: snapshot.buildDurationMs,
        snapshotProfileHash: snapshot.profileHash,
        snapshotRuntime: snapshot.runtime,
        snapshotDependencyCount: snapshot.dependencyCount,
        previousSnapshotIds,
        snapshotStatus: "ready",
        snapshotBuildProfileHash: snapshot.profileHash,
        snapshotBuildError: null,
        snapshotBuildSandboxName: null,
        snapshotBuildCommandId: null,
        updatedAt: new Date(),
      })
      .where(eq(juniorWorkspaces.id, workspaceId));
  });
}

/** Record a Workspace snapshot build that can continue outside one function invocation. */
export async function setWorkspaceSnapshotBuild(
  workspaceId: string,
  build: WorkspaceSnapshotBuild,
): Promise<void> {
  const executor = getSqlExecutor();
  await executor
    .db()
    .update(juniorWorkspaces)
    .set({
      snapshotStatus: build.status,
      snapshotBuildProfileHash: build.profileHash,
      snapshotBuildStartedAt: build.startedAt,
      snapshotBuildSandboxName: build.sandboxName,
      snapshotBuildCommandId: build.commandId,
      snapshotBuildError: build.error,
      updatedAt: new Date(),
    })
    .where(eq(juniorWorkspaces.id, workspaceId));
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
      previousSnapshotIds: [],
    });
  } catch (error) {
    // Dashboard enrichment must not fail a prepared Workspace Sandbox.
    logException(error, "sandbox.workspace_snapshot.persist.failed", {
      "app.workspace.id": workspaceId,
    });
  }
}

export { WorkspaceValidationError };
