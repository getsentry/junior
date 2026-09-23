import type { ObjectAnnotation } from "@sentry/junior-plugin-api";
import type { AutomationCard } from "./card";

/** Use the shared annotation model for Automation results and saved Message facts. */
export function automationAnnotation(card: AutomationCard): ObjectAnnotation {
  return {
    kind: "object",
    objectType: "automation",
    key: card.id,
    label: "Automation",
    title: card.title,
    url: card.url,
    description: card.instruction,
    fields: [
      { label: "When", value: card.trigger },
      ...(card.warning
        ? [{ label: "Needs attention", value: card.warning }]
        : []),
    ],
  };
}
