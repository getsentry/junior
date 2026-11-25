/**
 * The subject kinds that the Linear plugin names its objects with. Junior
 * stores each one as `linear:<kind>`. An Annotation of a Ticket names it by
 * its identifier, such as `ENG-123`: the hosted MCP server returns no other
 * stable id.
 */
import type { PluginInboxSubjectKind } from "@sentry/junior-plugin-api";

/** The subject kinds of Linear objects. */
export const LINEAR_SUBJECT_KINDS = {
  issue: "issue",
} as const;

/** The registered kinds and labels, for the plugin registration. */
export const linearInboxSubjectKinds: PluginInboxSubjectKind[] = [
  // An item about a Ticket belongs to the Conversation that created it.
  {
    kind: LINEAR_SUBJECT_KINDS.issue,
    label: "Ticket",
    owner: "annotation",
  },
];
