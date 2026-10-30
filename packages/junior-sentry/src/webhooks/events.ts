import {
  eventDataSchema,
  type EventData,
  type EventInput,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import {
  SENTRY_ISSUE_LEVELS,
  SENTRY_ISSUE_PRIORITIES,
  sentryIssueResource,
  sentryProjectResource,
} from "../events/issue.js";
import {
  SENTRY_METRIC_ALERT_ACTIONS,
  sentryMetricAlertResource,
} from "../events/metric-alert.js";
import { sentrySlugDataSchema } from "../events/scope.js";

// A level or priority that this plugin does not know counts as missing, so a
// new Sentry value does not reject the webhook or match a filter by mistake.
const issueLevelSchema = z
  .enum(SENTRY_ISSUE_LEVELS)
  .optional()
  .catch(undefined);
const issuePrioritySchema = z
  .enum(SENTRY_ISSUE_PRIORITIES)
  .optional()
  .catch(undefined);

const issueWebhookSchema = z
  .object({
    action: z.literal("created"),
    data: z.object({
      issue: z
        .object({
          culprit: z.string().optional(),
          firstSeen: z.string().optional(),
          id: z.string().min(1),
          issueCategory: z.string().optional(),
          issueType: z.string().optional(),
          level: issueLevelSchema,
          priority: issuePrioritySchema,
          project: z.object({ slug: z.string().min(1) }).passthrough(),
          title: z.string().optional(),
          url: z.string().url(),
          web_url: z.string().url().optional(),
        })
        .passthrough(),
    }),
    installation: z.object({ uuid: z.string().min(1) }).passthrough(),
  })
  .passthrough();

const metricAlertWebhookSchema = z
  .object({
    action: z.enum(SENTRY_METRIC_ALERT_ACTIONS),
    data: z.object({
      description_text: z.string().optional(),
      description_title: z.string().optional(),
      metric_alert: z
        .object({
          alert_rule: z
            .object({
              id: z.coerce.string().min(1),
              projects: z.array(z.string().min(1)).optional(),
            })
            .passthrough(),
          id: z.coerce.string().min(1),
        })
        .passthrough(),
      web_url: z.string().url(),
    }),
    installation: z.object({ uuid: z.string().min(1) }).passthrough(),
  })
  .passthrough();

/**
 * Read the org slug from a Sentry URL. Identifiers name the org, and a payload
 * with no readable org is ignored. Event data has no `org`, because one
 * integration belongs to one org. Sentry sends no org slug in issue or
 * metric alert webhooks, so the URL is the only place to read it. Issue API
 * URLs and some web URLs have an `/organizations/<org>/` path. Other web URLs
 * have an `<org>.sentry.io` host.
 */
function organizationSlug(url: string): string | undefined {
  const parsed = z.url().safeParse(url);
  if (!parsed.success) return undefined;
  const { hostname, pathname } = new URL(parsed.data);
  const segments = pathname.split("/").filter(Boolean);
  const index = segments.indexOf("organizations");
  const slug =
    index >= 0
      ? segments[index + 1]
      : hostname.split(".").length >= 3
        ? hostname.split(".")[0]
        : undefined;
  return slug?.toLowerCase() || undefined;
}

function providerTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  // Issue payloads use ISO timestamps; Sentry-Hook-Timestamp is unix seconds.
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? seconds * 1000 : undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Title and culprit come from the monitored app's code and error messages, so
 * they stay untrusted text.
 */
function issueText(issue: {
  culprit?: string;
  title?: string;
}): string | undefined {
  const parts = [
    issue.title ? `Title: ${issue.title}` : undefined,
    issue.culprit ? `Culprit: ${issue.culprit}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * Sentry's own values for an issue. Sentry sets them, so they are trusted.
 * `projects` has the one project of the issue.
 */
const issueEventDataSchema = z
  .object({
    projects: z.array(sentrySlugDataSchema).length(1),
    issueId: z.string().min(1),
    level: z.enum(SENTRY_ISSUE_LEVELS).optional(),
    priority: z.enum(SENTRY_ISSUE_PRIORITIES).optional(),
    issueCategory: z.string().min(1).optional(),
    issueType: z.string().min(1).optional(),
    url: z.string().url().optional(),
  })
  .strict();

/** Build the trusted data of one issue event. */
function issueData(
  issue: z.output<typeof issueWebhookSchema>["data"]["issue"],
): EventData {
  return issueEventDataSchema.parse(
    definedValues({
      projects: [issue.project.slug],
      issueId: issue.id,
      level: issue.level,
      priority: issue.priority,
      issueCategory: issue.issueCategory || undefined,
      issueType: issue.issueType || undefined,
      url: issue.web_url,
    }),
  );
}

/** Trusted data on every metric alert event. See `metricAlertData`. */
const metricAlertEventDataSchema = z
  .object({
    projects: z.array(sentrySlugDataSchema).min(1).optional(),
    alertRuleId: z.string().min(1),
    incidentId: z.string().min(1),
    url: z.string().url(),
  })
  .strict();

/** Drop missing values. A filter on a value Sentry did not send then does not match. */
function definedValues(data: Record<string, unknown>): EventData {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined),
  );
}

/**
 * Build the trusted data of one metric alert event. `projects` is missing
 * when the rule lists none. A rule on very many projects (about 72 with
 * 50-character slugs) can pass the event data size limit. Then `projects` is
 * left out too, so a `projects` filter does not match. The filter misses
 * the alert and never matches more. Each project copy still goes out.
 */
function metricAlertData(
  input: Omit<z.input<typeof metricAlertEventDataSchema>, "projects">,
  projects: string[],
): EventData {
  const data = metricAlertEventDataSchema.parse(
    definedValues({
      ...input,
      projects: projects.length > 0 ? projects : undefined,
    }),
  );
  if (eventDataSchema.safeParse(data).success) return data;
  const { projects: _projects, ...rest } = data;
  return rest;
}

interface WebhookInput {
  body: unknown;
  hookResource: string;
  hookTimestamp?: string;
}

function normalizeIssueEvents(input: WebhookInput): EventInput[] {
  const parsed = issueWebhookSchema.safeParse(input.body);
  if (!parsed.success) return [];

  const issue = parsed.data.data.issue;
  const org = organizationSlug(issue.url);
  if (!org) return [];
  const issueResource = sentryIssueResource({
    issueId: issue.id,
    org,
    project: issue.project.slug,
  });
  const projectResource = sentryProjectResource({
    org,
    project: issue.project.slug,
  });
  const eventType = "issue.created";
  const occurredAtMs =
    providerTime(issue.firstSeen) ??
    providerTime(input.hookTimestamp) ??
    Date.now();
  const untrustedText = issueText(issue);
  const event = {
    // Sentry assigns a new Request-ID to retries, so use resource identity for
    // idempotency across repeated deliveries of the same lifecycle event.
    eventKey: `sentry:${issueResource.identifier}:${eventType}`,
    eventType,
    objectType: "task",
    occurredAtMs,
    trustedSummary: `${issueResource.label} was created.`,
    data: issueData(issue),
    ...(untrustedText ? { untrustedText } : undefined),
  } satisfies Omit<EventInput, "identifier">;

  return [
    { ...event, identifier: issueResource.identifier },
    { ...event, identifier: projectResource.identifier },
  ];
}

function normalizeMetricAlertEvents(input: WebhookInput): EventInput[] {
  const parsed = metricAlertWebhookSchema.safeParse(input.body);
  if (!parsed.success) return [];
  const eventType = `metric_alert.${parsed.data.action}` as const;

  const { data } = parsed.data;
  const org = organizationSlug(data.web_url);
  if (!org) return [];
  const alertRuleId = data.metric_alert.alert_rule.id;
  const incidentId = data.metric_alert.id;
  const resource = sentryMetricAlertResource({ alertRuleId, org });
  // Alert titles and descriptions come from user-written rules.
  const untrustedText = [data.description_title, data.description_text]
    .filter((part): part is string => Boolean(part))
    .join("\n");

  // Also publish to each project of the alert rule, so one project
  // subscription receives its new issues and its metric alerts.
  const projects = [
    ...new Set(
      (data.metric_alert.alert_rule.projects ?? []).map((project) =>
        project.toLowerCase(),
      ),
    ),
  ];
  const event = {
    // One event per incident state. Sentry retries get new Request-IDs.
    eventKey: `sentry:${resource.identifier}:${incidentId}:${eventType}`,
    eventType,
    objectType: "item",
    occurredAtMs: providerTime(input.hookTimestamp) ?? Date.now(),
    trustedSummary: `${resource.label} is ${parsed.data.action}.`,
    data: metricAlertData(
      { alertRuleId, incidentId, url: data.web_url },
      projects,
    ),
    ...(untrustedText ? { untrustedText } : undefined),
  } satisfies Omit<EventInput, "identifier">;

  return [
    { ...event, identifier: resource.identifier },
    ...projects.map((project) => ({
      ...event,
      identifier: sentryProjectResource({ org, project }).identifier,
    })),
  ];
}

/** Normalize one verified Sentry webhook into subscribable Sentry events. */
export function normalizeSentryEvents(input: WebhookInput): EventInput[] {
  switch (input.hookResource) {
    case "issue":
      return normalizeIssueEvents(input);
    case "metric_alert":
      return normalizeMetricAlertEvents(input);
    default:
      return [];
  }
}
