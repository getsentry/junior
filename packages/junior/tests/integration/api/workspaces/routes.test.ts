import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import {
  apiErrorSchema,
  deleteWorkspaceResponseSchema,
  workspaceListSchema,
  workspaceSchema,
} from "@/api/schema";
import { closeDb, getDb, getSqlExecutor } from "@/chat/db";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { hash as workspaceProfileHash } from "@/chat/sandbox/snapshot/profile";
import { SANDBOX_RUNTIME } from "@/chat/sandbox/snapshot/runtime";
import { getStateAdapter } from "@/chat/state/adapter";
import {
  createWorkspace,
  getWorkspace,
  getWorkspaceByName,
  updateWorkspace,
} from "@/chat/workspaces/store";

function authenticatedApi(email = "person@example.com") {
  const app = new Hono<{ Variables: JuniorApiVariables }>();
  app.use("*", async (c, next) => {
    const viewer = await resolveViewerUser(email);
    if (!viewer) {
      throw new Error(`missing viewer for ${email}`);
    }
    c.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  return app;
}

describe("workspace admin API", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("creates, lists, updates, and deletes Workspace recipes", async () => {
    const app = authenticatedApi();

    const createResponse = await app.request("http://localhost/api/workspaces", {
      body: JSON.stringify({
        name: "Sentry",
        setupScript: "pnpm install",
        repos: [
          {
            provider: "github",
            repo: "getsentry/sentry"
          },
          {
            provider: "github",
            repo: "getsentry/getsentry"
          },
        ]
      }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
    expect(createResponse.status).toBe(201);
    const created = workspaceSchema.parse(await createResponse.json());
    expect(created).toMatchObject({
      name: "sentry",
      setupScript: "pnpm install",
      repos: [
        {
          provider: "github",
          repo: "getsentry/getsentry",
          checkoutPath: "repos/getsentry"
        },
        {
          provider: "github",
          repo: "getsentry/sentry",
          checkoutPath: "repos/sentry"
        },
      ]
    });

    const listResponse = await app.request("http://localhost/api/workspaces");
    expect(listResponse.status).toBe(200);
    const listed = workspaceListSchema.parse(await listResponse.json());
    expect(listed.workspaces.map((workspace) => workspace.id)).toContain(
      created.id,
    );

    const updateResponse = await app.request(
      `http://localhost/api/workspaces/${created.id}`,
      {
        body: JSON.stringify({
          name: "sentry-core",
          setupScript: "pnpm install --frozen-lockfile",
          repos: [
            {
              provider: "github",
              repo: "getsentry/sentry"
            },
          ]
        }),
        headers: { "content-type": "application/json" },
        method: "PUT"
      },
    );
    expect(updateResponse.status).toBe(200);
    const updated = workspaceSchema.parse(await updateResponse.json());
    expect(updated).toMatchObject({
      id: created.id,
      name: "sentry-core",
      setupScript: "pnpm install --frozen-lockfile",
      repos: [
        {
          provider: "github",
          repo: "getsentry/sentry",
          checkoutPath: "repos/sentry"
        },
      ]
    });

    const deleteResponse = await app.request(
      `http://localhost/api/workspaces/${created.id}`,
      { method: "DELETE" },
    );
    expect(deleteResponse.status).toBe(200);
    expect(
      deleteWorkspaceResponseSchema.parse(await deleteResponse.json()),
    ).toEqual({ deleted: true });

    const missing = await app.request(
      `http://localhost/api/workspaces/${created.id}`,
    );
    expect(missing.status).toBe(404);
    expect(apiErrorSchema.parse(await missing.json())).toEqual({
      error: "Workspace not found."
    });
  });

  it("returns snapshot build duration on Workspace detail", async () => {
    const app = authenticatedApi();
    const createResponse = await app.request("http://localhost/api/workspaces", {
      body: JSON.stringify({
        name: "snapshot-duration",
        repos: [{ provider: "github", repo: "getsentry/sentry" }],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(createResponse.status).toBe(201);
    const created = workspaceSchema.parse(await createResponse.json());
    const workspace = await getWorkspace(getDb(), created.id);
    expect(workspace).toBeDefined();

    const profileHash = workspaceProfileHash(SANDBOX_RUNTIME, workspace!);
    expect(profileHash).toBeTruthy();
    const state = getStateAdapter();
    await state.connect();
    await state.set(
      `junior:sandbox_snapshot_profile:v2:${profileHash}`,
      JSON.stringify({
        profileHash,
        snapshotId: "snap_duration",
        runtime: SANDBOX_RUNTIME,
        createdAtMs: Date.parse("2026-03-01T00:00:00.000Z"),
        dependencyCount: 1,
        buildDurationMs: 12_345,
      }),
    );

    const detailResponse = await app.request(
      `http://localhost/api/workspaces/${created.id}`,
    );
    expect(detailResponse.status).toBe(200);
    expect(workspaceSchema.parse(await detailResponse.json())).toMatchObject({
      id: created.id,
      snapshot: {
        id: "snap_duration",
        generatedAt: "2026-03-01T00:00:00.000Z",
        buildDurationMs: 12_345,
      },
    });
  });

  it("returns Workspace detail when snapshot cache lookup fails", async () => {
    const app = authenticatedApi();
    const createResponse = await app.request("http://localhost/api/workspaces", {
      body: JSON.stringify({
        name: "snapshot-cache",
        repos: [{ provider: "github", repo: "getsentry/sentry" }],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(createResponse.status).toBe(201);
    const created = workspaceSchema.parse(await createResponse.json());
    const workspace = await getWorkspace(getDb(), created.id);
    expect(workspace).toBeDefined();

    const profileHash = workspaceProfileHash(SANDBOX_RUNTIME, workspace!);
    expect(profileHash).toBeTruthy();
    const state = getStateAdapter();
    await state.connect();
    await state.set(
      `junior:sandbox_snapshot_profile:v2:${profileHash}`,
      "{not-json",
    );

    const detailResponse = await app.request(
      `http://localhost/api/workspaces/${created.id}`,
    );
    expect(detailResponse.status).toBe(200);
    expect(workspaceSchema.parse(await detailResponse.json())).toMatchObject({
      id: created.id,
      name: "snapshot-cache",
      snapshot: null,
      repos: [
        {
          provider: "github",
          repo: "getsentry/sentry",
          checkoutPath: "repos/sentry",
        },
      ],
    });
  });

  it("rejects invalid recipes with the stable error contract", async () => {
    const response = await authenticatedApi().request(
      "http://localhost/api/workspaces",
      {
        body: JSON.stringify({
          name: "bad name",
          repos: [{ provider: "github", repo: "getsentry/sentry" }]
        }),
        headers: { "content-type": "application/json" },
        method: "POST"
      },
    );

    expect(response.status).toBe(400);
    expect(apiErrorSchema.parse(await response.json()).error).toMatch(
      /name must start with a letter/i,
    );
  });

  it("rolls back recipe writes when repository replacement fails", async () => {
    const executor = getSqlExecutor();
    const original = await createWorkspace({
      name: "original",
      setupScript: "pnpm install",
      repos: [
        {
          provider: "github",
          repo: "getsentry/junior"
        },
      ]
    });

    await executor.execute(`
CREATE OR REPLACE FUNCTION junior_test_reject_workspace_repo()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'reject workspace repo for rollback test';
END;
$$ LANGUAGE plpgsql
`);
    await executor.execute(`
CREATE TRIGGER junior_test_reject_workspace_repo
BEFORE INSERT ON junior_workspace_repos
FOR EACH ROW EXECUTE FUNCTION junior_test_reject_workspace_repo()
`);

    try {
      await expect(
        createWorkspace({
          name: "partial-create",
          repos: [
            {
              provider: "github",
              repo: "getsentry/sentry"
            },
          ]
        }),
      ).rejects.toThrow(/junior_workspace_repos/);
      expect(
        await getWorkspaceByName(getDb(), "partial-create"),
      ).toBeUndefined();

      await expect(
        updateWorkspace(original.id, {
          name: "partial-update",
          setupScript: "changed",
          repos: [
            {
              provider: "github",
              repo: "getsentry/sentry"
            },
          ]
        }),
      ).rejects.toThrow(/junior_workspace_repos/);
      expect(await getWorkspace(getDb(), original.id)).toEqual(original);
    } finally {
      await executor.execute(
        "DROP TRIGGER IF EXISTS junior_test_reject_workspace_repo ON junior_workspace_repos",
      );
      await executor.execute(
        "DROP FUNCTION IF EXISTS junior_test_reject_workspace_repo()",
      );
    }
  });

  it("rejects duplicate names", async () => {
    const app = authenticatedApi();
    const body = {
      name: "shared",
      repos: [
        {
          provider: "github",
          repo: "getsentry/sentry"
        },
      ]
    };
    const first = await app.request("http://localhost/api/workspaces", {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
    expect(first.status).toBe(201);

    const second = await app.request("http://localhost/api/workspaces", {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
    expect(second.status).toBe(400);
    expect(apiErrorSchema.parse(await second.json())).toEqual({
      error: "Workspace name already exists: shared"
    });
  });
});
