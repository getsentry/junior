import { z } from "zod";
import { requireCredentialStart } from "@/chat/automations/edit-rules";
import { automationRevision } from "@/chat/automations/revision";
import {
  requireToolAutomation,
  requireToolCaller,
  type AutomationToolContext,
} from "@/chat/automations/tool-access";
import {
  automationToolResultSchema,
  compactAutomation,
} from "@/chat/automations/tool-support";
import { getDb } from "@/chat/db";
import type { EventCatalog } from "@/chat/events/catalog";
import { saveScheduledAutomation } from "@/chat/scheduled-automations/tasks";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

/** Create the tool that marks an active scheduled Automation due now. */
export function createRunAutomationNowTool(
  context: AutomationToolContext,
  catalog: EventCatalog,
) {
  return zodTool({
    approvalMode: "review",
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: false,
    },
    executionMode: "sequential",
    description:
      "Queue an existing active scheduled automation to run as soon as possible, without changing its schedule. Use when the user asks to run it now. Anyone who can manage the automation can run it. When it uses its creator's credentials, only the creator can run it now. Event automations run only when a matching event arrives, so they cannot run now.",
    inputSchema: z
      .object({
        automationId: z
          .string()
          .min(1)
          .describe(
            "ID of the active scheduled automation to run now, from searchAutomations or its dashboard URL.",
          ),
      })
      .strict(),
    outputSchema: automationToolResultSchema.omit({ objectCards: true }),
    async execute({ automationId }) {
      const current = await requireToolAutomation(
        await requireToolCaller(context),
        automationId,
      );
      if (current.kind !== "scheduled") {
        throw new ToolInputError(
          "Only scheduled automations can run now. Event automations run when a matching event arrives.",
        );
      }
      const { task, ownedByViewer } = current;
      if (task.status !== "active") {
        throw new ToolInputError(
          "Scheduled automation must be active before it can be run now.",
        );
      }
      requireCredentialStart(task, ownedByViewer);
      const nowMs = Date.now();
      const next = { ...task, updatedAtMs: nowMs, runNowAtMs: nowMs };
      await saveScheduledAutomation(getDb(), next, automationRevision(task));
      return {
        automation: compactAutomation({ ...current, task: next }, catalog),
      };
    },
  });
}
