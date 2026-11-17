/**
 * Link cards for one Sentry alert: a workflow that notifies people when its
 * monitors open or change an issue.
 *
 * The viewer's own Sentry account reads the alert, so Sentry decides who
 * may see it. The result is cached per viewer and alert for a minute:
 * `canView` reads the alert and the projects of its monitors, and `resolve`
 * draws the card from the same entry. Junior's org read token only finds
 * the org's region host.
 *
 * The card says when the alert fires and who it notifies, in plain words.
 * It never shows an email address.
 */
import type {
  ObjectAnnotation,
  ObjectFacts,
  ObjectLinkContext,
  PluginObjectLinkDefinition,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import {
  parseSentryAlertLink,
  SENTRY_ALERT_LINK_FILTERS,
  type SentryAlertLink,
} from "./alert-urls.js";
import { sentryApi, sentryData } from "./api.js";
import { sentryRegionOrigin } from "./region.js";

type AlertFacts = Extract<ObjectFacts, { type: "alert" }>;

// The same time as the card cache.
const ALERT_CACHE_TTL_MS = 60_000;
// Sentry refuses an alert that the token may not read, or a bad id.
const REFUSED = [400, 401, 403, 404];
// The card lists at most five projects and five notifications.
const LIST_MAX = 5;
// Monitors read to name the projects. An alert on more monitors than this
// names the projects of the first ones.
const DETECTORS_READ = 10;

const conditionSchema = z.object({
  type: z.string(),
  comparison: z.unknown(),
});

const conditionGroupSchema = z.object({
  logicType: z.string().nullish(),
  conditions: z.array(conditionSchema).nullish(),
});

const workflowSchema = z.object({
  name: z.string(),
  enabled: z.boolean(),
  environment: z.string().nullish(),
  detectorIds: z.array(z.union([z.string(), z.number()])).nullish(),
  lastTriggered: z.string().nullish(),
  triggers: conditionGroupSchema.nullish(),
  actionFilters: z
    .array(
      conditionGroupSchema.extend({
        actions: z
          .array(
            z.object({
              type: z.string(),
              config: z
                .object({
                  targetType: z.string().nullish(),
                  targetDisplay: z.string().nullish(),
                })
                .partial()
                .nullish(),
            }),
          )
          .nullish(),
      }),
    )
    .nullish(),
});

const detectorsSchema = z.array(
  z.object({ projectId: z.string().nullish() }).loose(),
);

const projectsSchema = z.array(z.object({ id: z.string(), slug: z.string() }));

/** What an alert card shows, read with the viewer's own token. */
interface SentryAlert {
  name: string;
  facts: AlertFacts;
}

// What starts an alert, in Sentry's words where they are short.
const TRIGGERS: Record<string, string> = {
  first_seen_event: "First seen",
  regression_event: "Regressed",
  reappeared_event: "Escalating",
  issue_resolved_trigger: "Resolved",
  every_event: "Every event",
  new_high_priority_issue: "New high priority issue",
  existing_high_priority_issue: "High priority issue",
  seer_activity_trigger: "Seer activity",
};

// `GroupCategory` in getsentry/sentry `issues/grouptype.py`.
const ISSUE_CATEGORIES: Record<number, string> = {
  1: "Error",
  2: "Performance",
  3: "Profile",
  4: "Cron",
  5: "Replay",
  6: "Feedback",
  7: "Uptime",
  8: "Metric alert",
  9: "Test notification",
  10: "Outage",
  11: "Metric",
  12: "DB query",
  13: "HTTP client",
  14: "Frontend",
  15: "Mobile",
  16: "AI detected",
  17: "Preprod",
  19: "Configuration",
};

const MATCHES: Record<string, string> = {
  eq: "is",
  ne: "is not",
  co: "contains",
  nc: "does not contain",
  sw: "starts with",
  nsw: "does not start with",
  ew: "ends with",
  new: "does not end with",
  in: "is in",
  nin: "is not in",
  is: "is set",
  ns: "is not set",
};

// Issue priority, as `PriorityLevel` in getsentry/sentry stores it.
const PRIORITIES: Record<number, string> = {
  25: "low",
  50: "medium",
  75: "high",
};

// Event level, as Python's `logging` numbers it.
const LEVELS: Record<number, string> = {
  0: "sample",
  10: "debug",
  20: "info",
  30: "warning",
  40: "error",
  50: "fatal",
};

const NOTIFY_CHANNELS: Record<string, string> = {
  slack: "Slack",
  slack_staging: "Slack",
  msteams: "Teams",
  discord: "Discord",
  pagerduty: "PagerDuty",
  opsgenie: "Opsgenie",
  webhook: "Webhook",
  sentry_app: "Sentry app",
  plugin: "Legacy integration",
  github: "GitHub issue",
  github_enterprise: "GitHub Enterprise issue",
  jira: "Jira issue",
  jira_server: "Jira Server issue",
  vsts: "Azure DevOps work item",
};

const EMAIL_TARGETS: Record<string, string> = {
  user: "Email member",
  team: "Email team",
  issue_owners: "Email issue owners",
};

// A target can name a person by email, which the card never shows.
const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/;

function text(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 160) : undefined;
}

function isoTime(value: string | null | undefined): string | undefined {
  const time = value ? Date.parse(value) : NaN;
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

// An unknown condition type still reads as words, such as "Issue type".
function humanize(type: string): string {
  const words = type.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function matchText(subject: unknown, match: unknown, value: unknown): string {
  const verb = typeof match === "string" ? (MATCHES[match] ?? match) : "is";
  const tail = match === "is" || match === "ns" ? "" : ` ${String(value)}`;
  return `${String(subject)} ${verb}${tail}`;
}

/** Say what one filter condition of an alert checks, in plain words. */
function filterText({ type, comparison }: z.infer<typeof conditionSchema>) {
  const fields =
    z.record(z.string(), z.unknown()).safeParse(comparison).data ?? {};
  switch (type) {
    case "issue_category": {
      const name = ISSUE_CATEGORIES[Number(fields["value"])];
      if (!name) break;
      return fields["include"] === false ? `Not ${name.toLowerCase()}` : name;
    }
    case "tagged_event":
      return matchText(fields["key"], fields["match"], fields["value"]);
    case "event_attribute":
      return matchText(fields["attribute"], fields["match"], fields["value"]);
    case "issue_priority_greater_or_equal":
    case "issue_priority_equals": {
      const priority = PRIORITIES[Number(comparison)];
      if (!priority) break;
      return type === "issue_priority_equals"
        ? `Priority is ${priority}`
        : `Priority ${priority} or higher`;
    }
    case "level": {
      const level = LEVELS[Number(fields["level"])];
      if (!level) break;
      const match = fields["match"];
      return match === "gte"
        ? `Level ${level} or higher`
        : match === "lte"
          ? `Level ${level} or lower`
          : `Level is ${level}`;
    }
    case "issue_occurrences":
      return `Seen ${String(fields["value"])}+ times`;
    case "event_frequency_count":
    case "event_unique_user_frequency_count": {
      const noun = type === "event_frequency_count" ? "events" : "users";
      return `Over ${String(fields["value"])} ${noun} in ${String(fields["interval"])}`;
    }
  }
  return humanize(type);
}

/** Summarize when an alert fires, such as "First seen · Feedback". */
function triggerText(
  workflow: z.infer<typeof workflowSchema>,
): string | undefined {
  const triggers = workflow.triggers?.conditions ?? [];
  const joiner = workflow.triggers?.logicType === "all" ? " and " : " or ";
  const when = triggers
    .map(({ type }) => TRIGGERS[type] ?? humanize(type))
    .join(joiner);
  const filters = (workflow.actionFilters ?? []).flatMap(
    ({ conditions }) => conditions?.map(filterText) ?? [],
  );
  const environment = text(workflow.environment);
  return text(
    [when, ...filters, environment && `In ${environment}`]
      .filter(Boolean)
      .join(" · "),
  );
}

/** Name each notification of an alert, such as "Slack @burak.kaya". */
function notifyTexts(workflow: z.infer<typeof workflowSchema>): string[] {
  const names = (workflow.actionFilters ?? []).flatMap(({ actions }) =>
    (actions ?? []).map(({ type, config }) => {
      if (type === "email") {
        return EMAIL_TARGETS[config?.targetType ?? ""] ?? "Email";
      }
      const channel = NOTIFY_CHANNELS[type] ?? humanize(type);
      const target = text(config?.targetDisplay);
      return target && !EMAIL_PATTERN.test(target)
        ? `${channel} ${target}`
        : channel;
    }),
  );
  return [...new Set(names.map((name) => name.slice(0, 160)))].slice(
    0,
    LIST_MAX,
  );
}

/** Name the projects of an alert's monitors, as the viewer may see them. */
async function readProjects(
  ctx: ObjectLinkContext,
  origin: string,
  org: string,
  detectorIds: number[],
): Promise<string[]> {
  if (detectorIds.length === 0) return [];
  const detectors = sentryData(
    await sentryApi(
      ctx.viewerEgress,
      origin,
      "sentry.detectors.list",
    ).listOrganizationDetectors({
      path: { organization_id_or_slug: org },
      query: { id: detectorIds.slice(0, DETECTORS_READ) },
    }),
    REFUSED,
    "monitor list",
  );
  const parsed = detectorsSchema.safeParse(detectors);
  if (!parsed.success) return [];
  const projectIds = [
    ...new Set(parsed.data.map(({ projectId }) => projectId ?? undefined)),
  ];
  // The org-wide monitor has no project: the alert covers every project.
  if (projectIds.includes(undefined)) return ["All projects"];
  const ids = projectIds.filter((id) => id !== undefined).slice(0, LIST_MAX);
  if (ids.length === 0) return [];
  const projects = sentryData(
    await sentryApi(
      ctx.viewerEgress,
      origin,
      "sentry.projects.list",
    ).listOrganizationProjects({
      path: { organization_id_or_slug: org },
      query: { query: ids.map((id) => `id:${id}`).join(" ") },
    }),
    REFUSED,
    "project read",
  );
  const slugs = projectsSchema.safeParse(projects);
  if (!slugs.success) return [];
  return ids
    .map((id) => slugs.data.find((project) => project.id === id)?.slug)
    .filter((slug) => slug !== undefined)
    .map((slug) => slug.slice(0, 160));
}

/** Read the alert with the viewer's token. Nothing when Sentry refuses. */
async function readAlert(
  ctx: ObjectLinkContext,
  origin: string,
  link: SentryAlertLink,
): Promise<SentryAlert | null> {
  const result = await sentryApi(
    ctx.viewerEgress,
    origin,
    "sentry.workflow.get",
  ).getOrganizationWorkflow({
    path: { organization_id_or_slug: link.org, workflow_id: link.workflowId },
  });
  const data = sentryData(result, REFUSED, "alert read");
  const parsed = data === null ? undefined : workflowSchema.safeParse(data);
  if (!parsed?.success) return null;
  const workflow = parsed.data;
  const detectorIds = (workflow.detectorIds ?? [])
    .map(Number)
    .filter(Number.isSafeInteger);
  return {
    name: workflow.name,
    facts: {
      type: "alert",
      enabled: workflow.enabled,
      projects: await readProjects(ctx, origin, link.org, detectorIds),
      trigger: triggerText(workflow),
      notifies: notifyTexts(workflow),
      lastTriggeredAt: isoTime(workflow.lastTriggered),
    },
  };
}

/** Read the alert for this viewer, cached per viewer and alert. */
async function viewerAlert(
  ctx: ObjectLinkContext,
  url: URL,
): Promise<{ link: SentryAlertLink; alert: SentryAlert } | null> {
  const link = parseSentryAlertLink(url);
  if (!link) return null;
  const alert = await ctx.cache.getOrLoad(
    `alert:${ctx.viewer.id}:${link.org}:${link.workflowId}`,
    async () => {
      const origin = await sentryRegionOrigin(ctx, link.org);
      const value = origin ? await readAlert(ctx, origin, link) : null;
      return { value, ttlMs: ALERT_CACHE_TTL_MS };
    },
  );
  return alert && { link, alert };
}

async function canViewSentryAlertLink(
  ctx: ObjectLinkContext,
  url: URL,
): Promise<boolean> {
  return (await viewerAlert(ctx, url)) !== null;
}

async function resolveSentryAlertLink(
  ctx: ObjectLinkContext,
  url: URL,
): Promise<ObjectAnnotation | undefined> {
  const read = await viewerAlert(ctx, url);
  if (!read) return undefined;
  const { link, alert } = read;
  return {
    kind: "object",
    objectType: "alert",
    key: `alert:${link.org}:${link.workflowId}`,
    label: alert.name.slice(0, 160),
    title: alert.name.slice(0, 512),
    url: url.href.length <= 2048 ? url.href : null,
    status: alert.facts.enabled ? "Enabled" : "Disabled",
    displayType: "Sentry alert",
    facts: alert.facts,
  };
}

/** Sentry alert links, on sentry.io and customer domains. */
export const sentryAlertLinks: PluginObjectLinkDefinition = {
  canView: canViewSentryAlertLink,
  filters: SENTRY_ALERT_LINK_FILTERS,
  objectTypes: ["alert"],
  resolve: resolveSentryAlertLink,
};
