import {
  eventMatchFieldsSchema,
  type EventMatchFields,
} from "@sentry/junior-plugin-api";
import { z } from "zod";

// The plugin lowercases every identifier, so scope values in event data are
// lowercase too. A saved identifier can then become exact filters.

/**
 * `repo` in event data: lowercase `owner/repo`. GitHub ignores case in
 * repository names, so tools accept this form.
 */
export const gitHubRepoDataSchema = z.string().min(1).toLowerCase();

/** `commitSha` in event data: the full lowercase commit SHA. */
export const gitHubCommitShaDataSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/i)
  .toLowerCase();

/** Filter on the repository of an event. */
export function gitHubRepoMatchFields(
  events: readonly string[],
): EventMatchFields {
  return eventMatchFieldsSchema.parse({
    repo: {
      kind: "string",
      case: "lower",
      description:
        "lowercase repository as owner/repo, such as getsentry/junior",
      events,
    },
  });
}

/** Filter on the commit of an event. */
export function gitHubCommitMatchFields(
  events: readonly string[],
): EventMatchFields {
  return eventMatchFieldsSchema.parse({
    commitSha: {
      kind: "string",
      case: "lower",
      description: "full lowercase Git commit SHA",
      events,
    },
  });
}
