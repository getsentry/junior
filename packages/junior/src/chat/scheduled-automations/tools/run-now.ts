import { requireCredentialStart } from "@/chat/automations/edit-rules";
import { automationRevision } from "@/chat/automations/revision";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { z } from "zod";
import { getDb } from "@/chat/db";
import { saveScheduledAutomation } from "../tasks";
import type { ScheduledAutomation } from "../types";
import {
  requireToolAutomation,
  requireToolCaller,
  type AutomationToolContext,
} from "@/chat/automations/tool-access";
import {
  compactTask,
  scheduleAutomationToolResultSchema,
  throwToolInputError,
} from "../tool-support";

/** Create a tool that marks an existing scheduled automation due immediately. */
export function createRunScheduledAutomationNowTool(
  context: AutomationToolContext,
) {
  return zodTool({
    approvalMode: "review",
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description:
      "Queue an existing active scheduled task to run as soon as possible, without changing its cadence. Use when the user asks to run an existing scheduled automation now. Anyone who can manage the automation can run it. When it uses its creator's credentials, only the creator can run it now.",
    executionMode: "sequential",
    inputSchema: z.object({
      automationId: z
        .string()
        .min(1)
        .describe(
          "ID of the active scheduled automation to run now, from searchScheduledAutomations or its dashboard URL.",
        ),
    }),
    outputSchema: scheduleAutomationToolResultSchema,
    execute: async ({ automationId }) => {
      const { task: lookup, ownedByViewer } = await requireToolAutomation(
        await requireToolCaller(context),
        "scheduled",
        automationId,
      );
      if (lookup.status !== "active") {
        throwToolInputError(
          "Scheduled automation must be active before it can be run now.",
        );
      }
      requireCredentialStart(lookup, ownedByViewer);

      const nowMs = Date.now();
      const next: ScheduledAutomation = {
        ...lookup,
        updatedAtMs: nowMs,
        runNowAtMs: nowMs,
      };

      await saveScheduledAutomation(getDb(), next, automationRevision(lookup));
      return { automation: compactTask(next, ownedByViewer) };
    },
  });
}
