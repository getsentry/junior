import { z } from "zod";

/** Native object types. `task` is the stored name for a Ticket. */
export const objectTypeSchema = z.enum([
  "task",
  "code_change",
  "automation",
  "deployment",
  "item",
]);
export type ObjectType = z.output<typeof objectTypeSchema>;

const objectTypeLabels = {
  task: "Ticket",
  code_change: "Code change",
  automation: "Automation",
  deployment: "Deployment",
  item: "Item",
} satisfies Record<ObjectType, string>;

const objectIconNames = [
  "issue-opened",
  "issue-closed",
  "git-pull-request",
  "git-pull-request-draft",
  "git-pull-request-closed",
  "git-merge",
  "workflow",
  "rocket",
  "package",
] as const;
export type ObjectIconName = (typeof objectIconNames)[number];
export type ObjectTone =
  | "neutral"
  | "success"
  | "danger"
  | "warning"
  | "info"
  | "accent";

/** Resolve identity and state without replacing the type icon with a warning. */
export function objectPresentation(object: {
  objectType: ObjectType;
  status?: string;
  facts?: { type: string };
}): { icon: ObjectIconName; tone: ObjectTone; label: string } {
  // Saved deployment cards used Item before Deployment became a native type.
  const type =
    object.objectType === "item" && object.facts?.type === "deployment"
      ? "deployment"
      : object.objectType;
  const status = object.status?.toLowerCase();
  let icon: ObjectIconName = (
    {
      task: "issue-opened",
      code_change: "git-pull-request",
      automation: "workflow",
      deployment: "rocket",
      item: "package",
    } satisfies Record<ObjectType, ObjectIconName>
  )[type];
  let tone: ObjectTone = type === "automation" ? "info" : "neutral";
  if (type === "code_change") {
    if (status === "draft") icon = "git-pull-request-draft";
    if (status === "closed") {
      icon = "git-pull-request-closed";
      tone = "danger";
    }
    if (status === "merged") {
      icon = "git-merge";
      tone = "accent";
    }
    if (status === "open") tone = "success";
  } else if (type === "task") {
    if (status === "closed") {
      icon = "issue-closed";
      tone = "accent";
    }
    if (status === "open") tone = "success";
  } else if (type === "deployment") {
    if (status === "ready" || status === "succeeded") tone = "success";
    if (status === "error" || status === "failed") tone = "danger";
    if (status === "building" || status === "in_progress") tone = "info";
  }
  if (status === "warning" || status === "blocked") tone = "warning";
  return { icon, tone, label: objectTypeLabels[type] };
}

/** Public, versioned asset path shared by Slack delivery and the web host. */
export function objectIconPath(icon: ObjectIconName): string {
  return `/_junior/dashboard/object-icons/v1/${icon}.png`;
}
