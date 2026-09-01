import { z } from "zod";
import { getDb } from "@/chat/db";
import { deleteEventTask } from "@/chat/event-tasks/store";
import {
  eventTaskSuccess,
  eventTaskToolResultSchema,
  writableEventTask,
} from "@/chat/event-tasks/tool-support";
import type { ResourceEventCatalog } from "@/chat/resource-events/catalog";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tools/types";

/** Create the core tool that deletes an event task. */
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
      "Delete an event task. Tasks in this Slack channel or DM are deletable here, including from other threads. Public tasks from another channel in the same Slack workspace are deletable by task id.",
    inputSchema: z.object({ taskId: z.string().min(1) }).strict(),
    outputSchema: eventTaskToolResultSchema,
    async execute({ taskId }) {
      const current = await writableEventTask(context, taskId);
      const deleted = await deleteEventTask(getDb(), current.id);
      if (!deleted) {
        throw new ToolInputError(
          "Event task was not found for this Slack workspace.",
        );
      }
      return eventTaskSuccess(deleted, catalog);
    },
  });
}
