import type { User } from "@sentry/junior-plugin-api";
import {
  AUTOMATION_ALERT_STEP_FIELD_ID,
  AUTOMATION_ALERT_STEPS,
} from "@/chat/automations/alert-items";
import { takeViewerAutomationAlertStep } from "@/chat/automations/edit";
import type { InboxItem } from "./store";

function isStepLabel(
  label: string,
): label is keyof typeof AUTOMATION_ALERT_STEPS {
  return Object.hasOwn(AUTOMATION_ALERT_STEPS, label);
}

/**
 * Take the step that a person picked on an Automation alert, Run again or
 * Pause, so core does the work. The answer starts no Turn. Throws when the
 * step fails, so the person can retry the same answer.
 */
export async function answerAutomationAlert(args: {
  item: InboxItem;
  user: User;
}): Promise<void> {
  const label = args.item.answer?.values[AUTOMATION_ALERT_STEP_FIELD_ID]?.[0];
  if (!label || !isStepLabel(label)) return;
  await takeViewerAutomationAlertStep(
    args.user,
    args.item.owner.id,
    AUTOMATION_ALERT_STEPS[label],
  );
}
