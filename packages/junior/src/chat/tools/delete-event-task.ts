import { z } from "zod";
import { getDb } from "@/chat/db";
import { saveActiveEventTask } from "@/chat/event-tasks/store";
import {
  eventTaskSuccess,
  eventTaskToolResultSchema,
  writableEventTask,
} from "@/chat/event-tasks/tool-support";
import type { EventTask } from "@/chat/event-tasks/types";
import type { ResourceEventCatalog } from "@/chat/resource-events/catalog";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tools/types";

/** Create the core tool that deletes an event task in this destination. */
export function createDeleteEventTaskTool(
  context: ToolRuntimeContext,
  catalog: ResourceEventCatalog,
) {
  return zodTool({
    approvalMode: "review",
    annotations: {
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
    executionMode: "sequential",
    description:
      "Delete an event task from this Slack channel or DM, including a task created from another thread in the same destination.",
    inputSchema: z.object({ taskId: z.string().min(1) }).strict(),
    outputSchema: eventTaskToolResultSchema,
    async execute({ taskId }) {
      const current = await writableEventTask(context, taskId);
      const next: EventTask = {
        ...current,
        status: "deleted",
      };
      const deleted = await saveActiveEventTask(getDb(), next);
      if (!deleted) {
        throw new ToolInputError(
          "Event task was not found in this Slack channel or DM.",
        );
      }
      return eventTaskSuccess(deleted, catalog);
    },
  });
}
