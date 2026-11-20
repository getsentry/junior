import * as z from "zod";
import { watchResultSchema } from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import {
  WORKSPACE_SNAPSHOT_FAILED_EVENT,
  WORKSPACE_SNAPSHOT_READY_EVENT,
  workspaceSnapshotWatch,
} from "@/chat/sandbox/snapshot/events";
import { ensureWorkspaceSnapshotBuild } from "@/chat/sandbox/snapshot/job-runner";
import { isWorkspaceSnapshotNotReadyError } from "@/chat/sandbox/snapshot/not-ready-error";
import { createWatch } from "@/chat/events/store";
import { RESOURCE_SUBSCRIPTION_DEFAULT_TTL_MS } from "@/chat/events/tool-support";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tool-support/types";
import { getWorkspaceByName } from "@/chat/workspaces/store";
import {
  tryRecordWorkspaceSwitchStat,
  stopWorkspaceSnapshotWatch,
  workspaceSchema,
  view,
  buildingWorkspaceResult,
} from "@/chat/workspaces/tool-support";

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

/** Build `switchWorkspace` for a Run that can select Workspaces. */
export function createSwitchWorkspaceTool(context: ToolRuntimeContext) {
  return zodTool({
    ...switchWorkspaceToolDefinition,
    async execute({ name }, options) {
      const workspace = await getWorkspaceByName(getDb(), name);
      if (!workspace) throw new ToolInputError(`Workspace not found: ${name}`);

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
            workspace: view(workspace),
            subscription,
          });
        }
        try {
          await context.workspaces!.switch(workspace, options.signal);
        } catch (error) {
          if (!isWorkspaceSnapshotNotReadyError(error)) throw error;
          await ensureWorkspaceSnapshotBuild({ workspace, sendAgain: true });
          keepWatch = true;
          return buildingWorkspaceResult({
            workspace: view(workspace),
            subscription,
          });
        }
        await tryRecordWorkspaceSwitchStat(workspace);
        return {
          workspace: view(workspace),
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
