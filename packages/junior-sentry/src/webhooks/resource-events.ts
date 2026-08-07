import type { ResourceEventInput } from "@sentry/junior-plugin-api";
import { z } from "zod";
import {
  sentryIssueResource,
  sentryProjectResource,
} from "../resource-events/issue.js";

const issueWebhookSchema = z
  .object({
    action: z.string(),
    data: z.object({
      issue: z
        .object({
          culprit: z.string().optional(),
          firstSeen: z.string().optional(),
          id: z.string().min(1),
          issueCategory: z.string().optional(),
          issueType: z.string().optional(),
          level: z.string().optional(),
          priority: z.string().optional(),
          project: z.object({ slug: z.string().min(1) }).passthrough(),
          status: z.string().optional(),
          substatus: z.string().optional().nullable(),
          title: z.string().optional(),
          url: z.string().url(),
          web_url: z.string().url().optional(),
        })
        .passthrough(),
    }),
    installation: z.object({ uuid: z.string().min(1) }).passthrough(),
  })
  .passthrough();

function organizationSlug(issueApiUrl: string): string | undefined {
  try {
    const segments = new URL(issueApiUrl).pathname.split("/").filter(Boolean);
    const organizationsIndex = segments.indexOf("organizations");
    return organizationsIndex >= 0
      ? segments[organizationsIndex + 1]
      : undefined;
  } catch {
    return undefined;
  }
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

function issueText(issue: {
  culprit?: string;
  issueCategory?: string;
  issueType?: string;
  level?: string;
  priority?: string;
  status?: string;
  substatus?: string | null;
  title?: string;
  web_url?: string;
}): string | undefined {
  const parts = [
    issue.title ? `Title: ${issue.title}` : undefined,
    issue.culprit ? `Culprit: ${issue.culprit}` : undefined,
    issue.level ? `Level: ${issue.level}` : undefined,
    issue.priority ? `Priority: ${issue.priority}` : undefined,
    issue.issueCategory ? `Category: ${issue.issueCategory}` : undefined,
    issue.issueType ? `Type: ${issue.issueType}` : undefined,
    issue.status ? `Status: ${issue.status}` : undefined,
    issue.substatus ? `Substatus: ${issue.substatus}` : undefined,
    issue.web_url ? `URL: ${issue.web_url}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/** Normalize one verified Sentry webhook into issue- and project-scoped events. */
export function normalizeSentryResourceEvents(input: {
  body: unknown;
  hookResource: string;
  hookTimestamp?: string;
  webhookOrg: string;
}): ResourceEventInput[] {
  if (input.hookResource !== "issue") return [];
  const parsed = issueWebhookSchema.safeParse(input.body);
  if (!parsed.success || parsed.data.action !== "created") return [];

  const issue = parsed.data.data.issue;
  const org = organizationSlug(issue.url)?.toLowerCase();
  if (!org || org !== input.webhookOrg.toLowerCase()) return [];
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
    occurredAtMs,
    trustedSummary: `${issueResource.label} was created.`,
    ...(untrustedText ? { untrustedText } : {}),
  } satisfies Omit<ResourceEventInput, "identifier">;

  return [
    { ...event, identifier: issueResource.identifier },
    { ...event, identifier: projectResource.identifier },
  ];
}
