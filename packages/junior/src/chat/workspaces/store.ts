import { asc, eq } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorWorkspaceRepos, juniorWorkspaces } from "@/db/schema";
import type { Workspace } from "./types";

function workspaceFromRows(
  row: typeof juniorWorkspaces.$inferSelect,
  repos: Array<typeof juniorWorkspaceRepos.$inferSelect>,
): Workspace {
  return {
    id: row.id,
    name: row.name,
    setupScript: row.setupScript,
    updatedAt: row.updatedAt,
    repos: repos.map((repo) => ({
      provider: repo.provider,
      repo: repo.repo,
      checkoutPath: repo.checkoutPath,
      isPrimary: repo.isPrimary,
    })),
  };
}

/** List workspace recipes by stable name. */
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
        asc(juniorWorkspaceRepos.checkoutPath),
      ),
  ]);
  return workspaces.map((workspace) =>
    workspaceFromRows(
      workspace,
      repos.filter((repo) => repo.workspaceId === workspace.id),
    ),
  );
}

/** Resolve one workspace recipe by name. */
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
  const repos = await db
    .select()
    .from(juniorWorkspaceRepos)
    .where(eq(juniorWorkspaceRepos.workspaceId, workspace.id))
    .orderBy(
      asc(juniorWorkspaceRepos.provider),
      asc(juniorWorkspaceRepos.repo),
      asc(juniorWorkspaceRepos.checkoutPath),
    );
  return workspaceFromRows(workspace, repos);
}

/** Resolve one workspace recipe by id. */
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
  const repos = await db
    .select()
    .from(juniorWorkspaceRepos)
    .where(eq(juniorWorkspaceRepos.workspaceId, workspace.id))
    .orderBy(
      asc(juniorWorkspaceRepos.provider),
      asc(juniorWorkspaceRepos.repo),
      asc(juniorWorkspaceRepos.checkoutPath),
    );
  return workspaceFromRows(workspace, repos);
}
