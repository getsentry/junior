import * as z from "zod";
import { watchResultSchema, type WatchResult } from "@sentry/junior-plugin-api";
import { cancelWatch, createWatch } from "@/chat/events/store";
import { RESOURCE_SUBSCRIPTION_DEFAULT_TTL_MS } from "@/chat/events/tool-support";
import { logWarn } from "@/chat/logging";
import { getDb } from "@/chat/db";
import {
  WORKSPACE_SNAPSHOT_FAILED_EVENT,
  WORKSPACE_SNAPSHOT_READY_EVENT,
  workspaceSnapshotWatch,
} from "@/chat/sandbox/snapshot/events";
import { ensureWorkspaceSnapshotBuild } from "@/chat/sandbox/snapshot/job-runner";
import { isWorkspaceSnapshotNotReadyError } from "@/chat/sandbox/snapshot/not-ready-error";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tool-support/types";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";
import { incrementStat } from "@/stats";
import { getWorkspaceByName } from "../store";
import { workspaceSchema, workspaceView } from "../tool-support";
import type { Workspace } from "../types";

/** Record optional reporting without changing the switchWorkspace outcome. */
async function tryRecordWorkspaceSwitchStat(workspace: Workspace) {
  if (!process.env["DATABASE_URL"]) return;
  try {
    await incrementStat({
      namespace: "junior",
      metric: "workspace_switch",
      name: workspace.id,
    });
  } catch (error) {
    logWarn("workspace.switch.stat.failed", {
      "app.workspace.id": workspace.id,
      "app.workspace.name": workspace.name,
      "exception.message":
        error instanceof Error ? error.message : String(error),
    });
  }
}

async function stopWorkspaceSnapshotWatch(input: {
  conversationId: string;
  subscriptionId: string;
}): Promise<void> {
  try {
    await cancelWatch({
      conversationId: input.conversationId,
      id: input.subscriptionId,
    });
  } catch (error) {
    logWarn("workspace.snapshot.watch.stop_failed", {
      "exception.message":
        error instanceof Error ? error.message : String(error),
    });
  }
}

/** Return building status and any already-created snapshot subscription. */
function buildingWorkspaceResult(input: {
  workspace: z.infer<typeof workspaceSchema>;
  subscription?: Pick<WatchResult, "id" | "events"> | null | undefined;
}) {
  return {
    workspace: input.workspace,
    status: "building" as const,
    ...(input.subscription
      ? {
          subscription: {
            id: input.subscription.id,
            events: [...input.subscription.events],
          },
        }
      : undefined),
  };
}

/** Static definition of `switchWorkspace`. */
export const switchWorkspaceToolDefinition = zodToolDefinition({
  executionMode: "sequential",
  exposure: "modelOnly",
  annotations: {
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
    readOnlyHint: false,
  },
  description:
    "Replace the current sandbox with a named repository Workspace. Files in the old sandbox do not carry over. Returns ready after the switch, or building with a temporary subscription when the snapshot is still being prepared. When building, wait for the ready event and call switchWorkspace again with the same name.",
  inputSchema: z
    .object({
      name: z.string().trim().min(1).describe("Exact workspace name."),
    })
    .strict(),
  outputSchema: juniorToolOutputSchema.extend({
    workspace: workspaceSchema,
    status: z.enum(["ready", "building"]),
    subscription: watchResultSchema
      .optional()
      .describe(
        "Present when the snapshot ready and failed events are already watched for this conversation.",
      ),
  }),
});

/** Build `switchWorkspace` for the Run's Conversation and Workspace switcher. */
export function createSwitchWorkspaceTool(context: {
  conversationId: string;
  workspaces: NonNullable<ToolRuntimeContext["workspaces"]>;
}) {
  const { workspaces } = context;
  return zodTool({
    ...switchWorkspaceToolDefinition,
    async execute({ name }, options) {
      const workspace = await getWorkspaceByName(getDb(), name);
      if (!workspace)
        throw new ToolInputError(
          `Workspace not found: ${name}. Use listWorkspaces to find its name.`,
        );

      // Watch before the build job can finish. A ready event is terminal and
      // will not replay for a late subscription.
      const watch = workspaceSnapshotWatch({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
      });
      const conversationId = context.conversationId.trim();
      const subscription = conversationId
        ? await createWatch({
            conversationId,
            events: [
              WORKSPACE_SNAPSHOT_READY_EVENT,
              WORKSPACE_SNAPSHOT_FAILED_EVENT,
            ],
            expiresAtMs: Date.now() + RESOURCE_SUBSCRIPTION_DEFAULT_TTL_MS,
            intent: `Switch to Workspace ${workspace.name} when its snapshot is ready.`,
            label: watch.label,
            namespace: watch.namespace,
            identifier: watch.identifier,
            resourceType: watch.type,
          })
        : undefined;

      let keepWatch = false;
      try {
        const status = await ensureWorkspaceSnapshotBuild({ workspace });
        if (status === "building") {
          keepWatch = true;
          return buildingWorkspaceResult({
            workspace: workspaceView(workspace),
            subscription,
          });
        }
        try {
          await workspaces.switch(workspace, options.signal);
        } catch (error) {
          if (!isWorkspaceSnapshotNotReadyError(error)) throw error;
          await ensureWorkspaceSnapshotBuild({ workspace, sendAgain: true });
          keepWatch = true;
          return buildingWorkspaceResult({
            workspace: workspaceView(workspace),
            subscription,
          });
        }
        await tryRecordWorkspaceSwitchStat(workspace);
        return {
          workspace: workspaceView(workspace),
          status: "ready" as const,
        };
      } finally {
        if (!keepWatch && subscription && conversationId) {
          await stopWorkspaceSnapshotWatch({
            conversationId,
            subscriptionId: subscription.id,
          });
        }
      }
    },
  });
}
