import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { getSqlExecutor } from "@/chat/db";
import type { JuniorDatabase, JuniorSqlDatabase } from "@/db/db";
import { juniorWorkspaceRepos, juniorWorkspaces } from "@/db/schema";
import type { Workspace } from "./types";
import {
  normalizeWorkspaceRecipe,
  WorkspaceValidationError,
  type WorkspaceRecipeInput,
} from "./validation";

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
      isPrimary: repo.isPrimary,
    })),
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
      isPrimary: repo.isPrimary,
    })),
  );
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
export async function createWorkspace(
  input: {
    name: string;
    setupScript?: string;
    repos: Array<{
      provider: string;
      repo: string;
      isPrimary?: boolean;
    }>;
  },
  options: {
    db?: JuniorDatabase;
    executor?: JuniorSqlDatabase;
    now?: Date;
  } = {},
): Promise<Workspace> {
  const recipe = normalizeWorkspaceRecipe(input);
  const executor = options.executor ?? getSqlExecutor();
  const db = options.db ?? executor.db();
  const now = options.now ?? new Date();
  const id = randomUUID();

  try {
    await executor.transaction(async () => {
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

  return (await getWorkspace(db, id))!;
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
      isPrimary?: boolean;
    }>;
  },
  options: {
    db?: JuniorDatabase;
    executor?: JuniorSqlDatabase;
    now?: Date;
  } = {},
): Promise<Workspace | undefined> {
  const recipe = normalizeWorkspaceRecipe(input);
  const executor = options.executor ?? getSqlExecutor();
  const db = options.db ?? executor.db();
  const now = options.now ?? new Date();

  try {
    const updated = await executor.transaction(async () => {
      const rows = await db
        .update(juniorWorkspaces)
        .set({
          name: recipe.name,
          setupScript: recipe.setupScript,
          updatedAt: now,
        })
        .where(eq(juniorWorkspaces.id, id))
        .returning();
      if (!rows[0]) return undefined;
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

  return await getWorkspace(db, id);
}

/** Delete one install-wide Workspace recipe. */
export async function deleteWorkspace(
  id: string,
  options: {
    db?: JuniorDatabase;
    executor?: JuniorSqlDatabase;
  } = {},
): Promise<boolean> {
  const executor = options.executor ?? getSqlExecutor();
  const db = options.db ?? executor.db();
  return await executor.transaction(async () => {
    const rows = await db
      .delete(juniorWorkspaces)
      .where(eq(juniorWorkspaces.id, id))
      .returning({ id: juniorWorkspaces.id });
    return rows.length > 0;
  });
}

export { WorkspaceValidationError };
