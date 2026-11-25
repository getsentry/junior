import type { CodeChangeSize } from "@sentry/junior-plugin-api";

import type { ListedObject } from "./display-text/DisplayText";

/**
 * The live size of a listed code change, once its card came. Undefined when
 * the card has no size field.
 */
export function listedChangeSize(
  listed: ListedObject,
): CodeChangeSize | undefined {
  const facts = listed.card?.facts;
  if (facts?.type !== "code_change") return undefined;
  const sized =
    facts.additions !== undefined ||
    facts.deletions !== undefined ||
    facts.changedFiles !== undefined;
  return sized ? facts : undefined;
}

/** Whether the live card of a listed code change says it is a draft. */
export function listedDraft(listed: ListedObject): boolean {
  return listed.card?.status === "draft";
}
