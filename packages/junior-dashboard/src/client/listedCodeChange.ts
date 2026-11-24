import type { CodeChangeSize } from "@sentry/junior-plugin-api";

import type { ListedObject } from "./display-text/DisplayText";

/** The live size of a listed code change, once its card came. */
export function listedChangeSize(
  listed: ListedObject,
): CodeChangeSize | undefined {
  const facts = listed.card?.facts;
  return facts?.type === "code_change" ? facts : undefined;
}

/** Whether the live card of a listed code change says it is a draft. */
export function listedDraft(listed: ListedObject): boolean {
  return listed.card?.status === "draft";
}
