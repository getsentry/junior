// Compiled against the packed release tarballs by release-artifacts.mjs. A
// package packed before its dependencies are built exports `any` types,
// and then the expected error below does not happen.
import type { ConversationReportMessageEvent } from "@sentry/junior/api/schema";

export const valid: ConversationReportMessageEvent["objectType"] = "task";
// @ts-expect-error Public object types must reject numbers.
export const invalid: ConversationReportMessageEvent["objectType"] = 12345;
