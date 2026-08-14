import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import {
  apiErrorSchema,
  deleteWorkspaceResponseSchema,
  workspaceListSchema,
  workspaceSchema,
} from "@/api/schema";
import { closeDb } from "@/chat/db";
import { resolveViewerUser } from "@/chat/plugins/viewer";

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
            repo: "getsentry/sentry",
            isPrimary: true,
          },
          {
            provider: "github",
            repo: "getsentry/getsentry",
          },
        ],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
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
          checkoutPath: "repos/getsentry",
          isPrimary: false,
        },
        {
          provider: "github",
          repo: "getsentry/sentry",
          checkoutPath: "repos/sentry",
          isPrimary: true,
        },
      ],
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
              repo: "getsentry/sentry",
              isPrimary: true,
            },
          ],
        }),
        headers: { "content-type": "application/json" },
        method: "PUT",
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
          checkoutPath: "repos/sentry",
          isPrimary: true,
        },
      ],
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
      error: "Workspace not found.",
    });
  });

  it("rejects invalid recipes with the stable error contract", async () => {
    const response = await authenticatedApi().request(
      "http://localhost/api/workspaces",
      {
        body: JSON.stringify({
          name: "bad name",
          repos: [{ provider: "github", repo: "getsentry/sentry" }],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );

    expect(response.status).toBe(400);
    expect(apiErrorSchema.parse(await response.json()).error).toMatch(
      /name must start with a letter/i,
    );
  });

  it("rejects duplicate names", async () => {
    const app = authenticatedApi();
    const body = {
      name: "shared",
      repos: [
        {
          provider: "github",
          repo: "getsentry/sentry",
          isPrimary: true,
        },
      ],
    };
    const first = await app.request("http://localhost/api/workspaces", {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(first.status).toBe(201);

    const second = await app.request("http://localhost/api/workspaces", {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(second.status).toBe(400);
    expect(apiErrorSchema.parse(await second.json())).toEqual({
      error: "Workspace name already exists: shared",
    });
  });
});
