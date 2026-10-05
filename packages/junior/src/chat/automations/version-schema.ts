/** Saved Automation definition shapes. Kept free of storage imports for API schemas. */
import { z } from "zod";
import {
  eventAutomationPrincipalSchema,
  eventAutomationSchema,
} from "@/chat/event-automations/types";
import { scheduledAutomationSchema } from "@/chat/scheduled-automations/types";

const definitionBase = {
  title: z.string().nullable(),
  instruction: z.string(),
};

/** Editable scheduled-automation fields. Scheduler and lifecycle state are excluded. */
export const scheduledAutomationDefinitionSchema = scheduledAutomationSchema
  .pick({
    credentialMode: true,
    destination: true,
    outcomes: true,
    schedule: true,
  })
  .extend(definitionBase)
  .strict();

/** Editable event-automation fields. Lifecycle state is excluded. */
export const eventAutomationDefinitionSchema = eventAutomationSchema
  .pick({
    credentialMode: true,
    destination: true,
    outcomes: true,
    trigger: true,
  })
  .extend(definitionBase)
  .strict();

/** Slack principal that saved one Automation version. Null when unknown. */
export const automationEditorSchema = eventAutomationPrincipalSchema;

export type AutomationEditor = z.output<typeof automationEditorSchema>;
export type ScheduledAutomationDefinition = z.output<
  typeof scheduledAutomationDefinitionSchema
>;
export type EventAutomationDefinition = z.output<
  typeof eventAutomationDefinitionSchema
>;
