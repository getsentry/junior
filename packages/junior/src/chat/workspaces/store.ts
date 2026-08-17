import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { getSqlExecutor } from "@/chat/db";
import { logException } from "@/chat/logging";
import { deleteWorkspaceSnapshotBuilders } from "@/chat/sandbox/snapshot/builder-sandbox";
import { hash as workspaceProfileHash } from "@/chat/sandbox/snapshot/profile";
import { SANDBOX_RUNTIME } from "@/chat/sandbox/snapshot/runtime";
import {
  clearNonReadySnapshots,
  loadSnapshotsForProfile,
} from "@/chat/sandbox/snapshot/store";
import type { JuniorDatabase } from "@/db/db";
import { juniorWorkspaceRepos, juniorWorkspaces } from "@/db/schema";
import type { Workspace, WorkspaceSnapshot } from "./types";
import {
  normalizeWorkspaceRecipe,
  WorkspaceValidationError,
  type WorkspaceRecipeInput,
} from "./validation";

function workspaceFromRows(
  row: typeof juniorWorkspaces.$inferSelect,
  repos: Array<typeof juniorWorkspaceRepos.$inferSelect>,
  snapshot: WorkspaceSnapshot | null,
): Workspace {
  return {
    id: row.id,
    name: row.name,
    setupScript: row.setupScript,
    repos: repos.map((repo) => ({
      provider: repo.provider,
      repo: repo.repo,
    })),
    snapshot,
  };
}

async function workspaceWithSnapshot(
  db: JuniorDatabase,
  row: typeof juniorWorkspaces.$inferSelect,
  repos: Array<typeof juniorWorkspaceRepos.$inferSelect>,
): Promise<Workspace> {
  const workspace = workspaceFromRows(row, repos, null);
  const profileHash = workspaceProfileHash(SANDBOX_RUNTIME, workspace);
  if (!profileHash) return workspace;
  const snapshots = await loadSnapshotsForProfile(
    db,
    workspace.id,
    profileHash,
  );
  return { ...workspace, snapshot: snapshots.ready };
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

async function cleanupSnapshotBuilders(
  workspaceId: string,
  names: string[],
): Promise<void> {
  if (names.length === 0) return;
  try {
    await deleteWorkspaceSnapshotBuilders(names);
  } catch (error) {
    logException(error, "sandbox.workspace_snapshot.builder.delete_failed", {
      "app.workspace.id": workspaceId,
      "app.sandbox.snapshot.builder_count": names.length,
    });
  }
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
      null,
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
  return await workspaceWithSnapshot(
    db,
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
  return await workspaceWithSnapshot(
    db,
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
    const result = await executor.transaction(async () => {
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
      const builderNames = snapshotChanged
        ? await clearNonReadySnapshots(db, id)
        : [];
      return { builderNames, workspace: rows[0] };
    });
    if (!result) return undefined;
    await cleanupSnapshotBuilders(id, result.builderNames);
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
  const result = await executor.transaction(async () => {
    const db = executor.db();
    const builderNames = await clearNonReadySnapshots(db, id);
    const rows = await db
      .delete(juniorWorkspaces)
      .where(eq(juniorWorkspaces.id, id))
      .returning({ id: juniorWorkspaces.id });
    return { builderNames, deleted: rows.length > 0 };
  });
  await cleanupSnapshotBuilders(id, result.builderNames);
  return result.deleted;
}

export { WorkspaceValidationError };
