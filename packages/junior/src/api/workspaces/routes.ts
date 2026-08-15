import { Hono } from "hono";
import { getDb } from "@/chat/db";
import { hash as workspaceProfileHash } from "@/chat/sandbox/snapshot/profile";
import { SANDBOX_RUNTIME } from "@/chat/sandbox/snapshot/runtime";
import { workspaceRepoCheckoutPath } from "@/chat/workspaces/checkout-path";
import {
  createWorkspace,
  deleteWorkspace,
  getWorkspace,
  listWorkspaces,
  updateWorkspace,
  WorkspaceValidationError,
} from "@/chat/workspaces/store";
import type { Workspace } from "@/chat/workspaces/types";
import { jsonResponse, throwApiError } from "../http";
import type { JuniorApiEnv } from "../route";
import {
  deleteWorkspaceResponseSchema,
  workspaceBodySchema,
  workspaceListSchema,
  workspaceParamsSchema,
  workspaceSchema,
} from "../schema/workspace";
import { validateRequest } from "../validation";
import { requireViewer } from "../viewer";

function snapshotView(workspace: Workspace) {
  const recorded = workspace.snapshot;
  if (!recorded) return null;
  const profileHash = workspaceProfileHash(SANDBOX_RUNTIME, workspace);
  // Hide a recorded snapshot when the recipe no longer matches its profile.
  if (!profileHash || recorded.profileHash !== profileHash) return null;
  return {
    id: recorded.id,
    generatedAt: recorded.generatedAt.toISOString(),
    buildDurationMs: recorded.buildDurationMs,
  };
}

function view(workspace: Workspace) {
  return {
    id: workspace.id,
    name: workspace.name,
    setupScript: workspace.setupScript,
    prebuild: workspace.prebuild ?? false,
    repos: workspace.repos.map((repo) => ({
      provider: repo.provider,
      repo: repo.repo,
      checkoutPath: workspaceRepoCheckoutPath(repo.repo),
    })),
    snapshot: null as ReturnType<typeof snapshotView>,
  };
}

function detailView(workspace: Workspace) {
  return {
    ...view(workspace),
    snapshot: snapshotView(workspace),
  };
}

function handleValidationError(error: unknown): never {
  if (error instanceof WorkspaceValidationError) {
    throwApiError(400, error.message);
  }
  throw error;
}

/** Create authenticated native Workspace list and admin routes. */
export function createWorkspaceRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();

  app.get("/", requireViewer, async () => {
    return jsonResponse(workspaceListSchema, {
      workspaces: (await listWorkspaces(getDb())).map(view),
    });
  });

  app.post(
    "/",
    requireViewer,
    validateRequest("json", workspaceBodySchema, "Invalid request body."),
    async (context) => {
      const body = context.req.valid("json");
      try {
        const workspace = await createWorkspace(body);
        return jsonResponse(workspaceSchema, view(workspace), { status: 201 });
      } catch (error) {
        handleValidationError(error);
      }
    },
  );

  app.get(
    "/:id",
    requireViewer,
    validateRequest(
      "param",
      workspaceParamsSchema,
      "Invalid route parameters.",
    ),
    async (context) => {
      const { id } = context.req.valid("param");
      const workspace = await getWorkspace(getDb(), id);
      if (!workspace) throwApiError(404, "Workspace not found.");
      return jsonResponse(workspaceSchema, detailView(workspace));
    },
  );

  app.put(
    "/:id",
    requireViewer,
    validateRequest(
      "param",
      workspaceParamsSchema,
      "Invalid route parameters.",
    ),
    validateRequest("json", workspaceBodySchema, "Invalid request body."),
    async (context) => {
      const { id } = context.req.valid("param");
      const body = context.req.valid("json");
      try {
        const workspace = await updateWorkspace(id, body);
        if (!workspace) throwApiError(404, "Workspace not found.");
        return jsonResponse(workspaceSchema, view(workspace));
      } catch (error) {
        handleValidationError(error);
      }
    },
  );

  app.delete(
    "/:id",
    requireViewer,
    validateRequest(
      "param",
      workspaceParamsSchema,
      "Invalid route parameters.",
    ),
    async (context) => {
      const { id } = context.req.valid("param");
      if (!(await deleteWorkspace(id))) {
        throwApiError(404, "Workspace not found.");
      }
      return jsonResponse(deleteWorkspaceResponseSchema, {
        deleted: true as const,
      });
    },
  );

  return app;
}
