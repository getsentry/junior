/** Storage revisions prevent stale edits from replacing newer values. */
import { createHash } from "node:crypto";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { EventAutomation } from "@/chat/event-automations/types";
import type { ScheduledAutomation } from "@/chat/scheduled-automations/types";

export class AutomationConflictError extends ToolInputError {
  constructor() {
    super(
      "This Automation changed after it was loaded. Reload it before saving.",
    );
    this.name = "AutomationConflictError";
  }
}

/** Sort object keys so equal values produce equal JSON. */
export function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalJson(child)]),
    );
  }
  return value;
}

/** Identify the stored values being edited, including lifecycle and creator authority. */
export function automationRevision(
  task: EventAutomation | ScheduledAutomation,
): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalJson(task)))
    .digest("hex");
}

/** Reject a stale edit while the storage owner holds the write lock. */
export function requireAutomationRevision(
  task: EventAutomation | ScheduledAutomation | undefined,
  revision: string,
): void {
  if (!task || automationRevision(task) !== revision)
    throw new AutomationConflictError();
}
