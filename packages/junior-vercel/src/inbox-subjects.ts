/**
 * The subject kinds that the Vercel plugin names its objects with. Junior
 * stores each one as `vercel:<kind>`. An Annotation of a deployment names
 * it by the deployment id.
 */
import type { PluginInboxSubjectKind } from "@sentry/junior-plugin-api";

/** The subject kinds of Vercel objects. */
export const VERCEL_SUBJECT_KINDS = {
  deployment: "deployment",
} as const;

/** The registered kinds and labels, for the plugin registration. */
export const vercelInboxSubjectKinds: PluginInboxSubjectKind[] = [
  // An item about a deployment belongs to the Conversation that created it.
  {
    kind: VERCEL_SUBJECT_KINDS.deployment,
    label: "Deployment",
    owner: "annotation",
  },
];
