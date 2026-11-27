/**
 * The subject kinds that the Google plugin names its objects with. Junior
 * stores each one as `google:<kind>`. An Annotation of a Calendar event
 * names it by the event id.
 */
import type { PluginInboxSubjectKind } from "@sentry/junior-plugin-api";

/** The subject kinds of Google objects. */
export const GOOGLE_SUBJECT_KINDS = {
  calendarEvent: "calendar_event",
} as const;

/** The registered kinds and labels, for the plugin registration. */
export const googleInboxSubjectKinds: PluginInboxSubjectKind[] = [
  // An item about an event belongs to the Conversation that created it.
  {
    kind: GOOGLE_SUBJECT_KINDS.calendarEvent,
    label: "Calendar event",
    owner: "annotation",
  },
];
