/**
 * Link cards for Sentry traces.
 *
 * A trace can cross projects that its reader may not see, so the viewer's
 * own Sentry account reads it, and Sentry decides what it shows. The result
 * is cached per viewer and trace for a minute: `canView` reads the trace,
 * and `resolve` draws the card from the same entry. Junior's org read token
 * only finds the org's region host. The card shows the root span, totals,
 * and the first top-level spans, never span data or attributes.
 */
import {
  OBJECT_FACTS_MAX_BYTES,
  objectFactsBytes,
  type ObjectAnnotation,
  type ObjectFacts,
  type ObjectLinkContext,
  type PluginObjectLinkDefinition,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { sentryApi, sentryData } from "./api.js";
import { sentryRegionOrigin } from "./region.js";
import {
  parseSentryTraceLink,
  SENTRY_TRACE_LINK_FILTERS,
  type SentryTraceLink,
} from "./trace-urls.js";

// The same time as the card cache, so a growing trace shows within a minute.
const TRACE_CACHE_TTL_MS = 60_000;
const MAX_SPANS = 12;
const MAX_PROJECTS = 5;
// Without a timestamp, the trace view looks back this far.
const DEFAULT_PERIOD = "14d";
// Sentry refuses a trace that the token may not read, or a bad trace id.
const REFUSED = [400, 401, 403, 404];

type TraceFacts = Extract<ObjectFacts, { type: "trace" }>;

/** What a trace card shows, read with the viewer's own token. */
interface SentryTrace {
  title: string;
  facts: TraceFacts;
}

interface TraceNode {
  event_type?: string | undefined;
  op?: string | null | undefined;
  description?: string | null | undefined;
  name?: string | null | undefined;
  transaction?: string | null | undefined;
  project_slug?: string | null | undefined;
  start_timestamp: number;
  end_timestamp?: number | null | undefined;
  children?: TraceNode[] | undefined;
  errors?: unknown[] | undefined;
  occurrences?: unknown[] | undefined;
}

// Trace items are spans, errors, and other events. Each item keeps only
// the fields the card reads.
const traceNodeSchema: z.ZodType<TraceNode> = z.lazy(() =>
  z
    .object({
      event_type: z.string().optional(),
      op: z.string().nullish(),
      description: z.string().nullish(),
      name: z.string().nullish(),
      transaction: z.string().nullish(),
      project_slug: z.string().nullish(),
      start_timestamp: z.number(),
      end_timestamp: z.number().nullish(),
      children: z.array(traceNodeSchema).optional(),
      errors: z.array(z.unknown()).optional(),
      occurrences: z.array(z.unknown()).optional(),
    })
    .loose(),
);

const traceMetaSchema = z.object({
  errorsCount: z.number().int().nonnegative(),
  performanceIssuesCount: z.number().int().nonnegative(),
  spansCount: z.number().int().nonnegative(),
});

function text(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 160) : undefined;
}

// Every span of a transaction carries its transaction name, so a span's
// own description comes first. The root's transaction is the trace's name.
function nodeName(node: TraceNode): string | undefined {
  return text(node.description) ?? text(node.name) ?? text(node.transaction);
}

// Seconds to milliseconds, to a tenth of a millisecond.
function ms(seconds: number): number {
  return Math.max(0, Math.round(seconds * 10_000) / 10);
}

// Errors and other events can sit among the spans.
function isSpan(node: TraceNode): boolean {
  return node.event_type === undefined || node.event_type === "span";
}

function byStart(a: TraceNode, b: TraceNode): number {
  return a.start_timestamp - b.start_timestamp;
}

function endOf(node: TraceNode): number {
  return node.end_timestamp ?? node.start_timestamp;
}

function traceProjects(roots: TraceNode[]): string[] {
  const projects = new Set<string>();
  // Breadth first, so the projects nearest the root come first.
  const pending = [...roots];
  for (let i = 0; i < pending.length && projects.size < MAX_PROJECTS; i++) {
    const project = text(pending[i]!.project_slug);
    if (project) projects.add(project);
    pending.push(...(pending[i]!.children ?? []));
  }
  return [...projects];
}

/** Build the card from the trace's root items and its totals. */
function traceCard(
  link: SentryTraceLink,
  roots: TraceNode[],
  meta: z.infer<typeof traceMetaSchema>,
): SentryTrace | null {
  const spans = roots.filter(isSpan).sort(byStart);
  const root = spans[0];
  if (!root || meta.spansCount === 0) return null;
  const start = Math.min(...roots.map((node) => node.start_timestamp));
  const end = Math.max(...roots.map(endOf));
  // The root and its direct children, then other root spans, by start.
  const topLevel = [
    root,
    ...(root.children ?? []).filter(isSpan),
    ...spans.slice(1),
  ]
    .sort(byStart)
    .slice(0, MAX_SPANS);
  const rootName = text(root.transaction) ?? nodeName(root);
  const facts: TraceFacts = {
    type: "trace",
    rootOp: text(root.op),
    rootName,
    durationMs: ms(end - start),
    spanCount: meta.spansCount,
    errorCount: meta.errorsCount,
    performanceIssueCount: meta.performanceIssuesCount,
    projects: traceProjects(roots),
    spans: topLevel.map((node) => ({
      op: text(node.op),
      name: nodeName(node) ?? text(node.op) ?? "(no name)",
      startMs: ms(node.start_timestamp - start),
      durationMs: ms(endOf(node) - node.start_timestamp),
      issue: node.errors?.length || node.occurrences?.length ? true : undefined,
    })),
  };
  // Long span names can pass the facts limit. Drop the last spans until
  // the facts fit.
  while (objectFactsBytes(facts) > OBJECT_FACTS_MAX_BYTES) facts.spans.pop();
  return { title: rootName ?? `Trace ${link.traceId.slice(0, 8)}`, facts };
}

/**
 * Read the trace and its totals with the viewer's token. Nothing when
 * Sentry refuses it, or when the viewer may see none of its spans.
 */
async function readTrace(
  ctx: ObjectLinkContext,
  origin: string,
  link: SentryTraceLink,
): Promise<SentryTrace | null> {
  const path = { organization_id_or_slug: link.org, trace_id: link.traceId };
  const query = link.timestamp
    ? { timestamp: link.timestamp }
    : { statsPeriod: DEFAULT_PERIOD };
  const [metaResult, traceResult] = await Promise.all([
    sentryApi(
      ctx.viewerEgress,
      origin,
      "sentry.trace_meta.get",
    ).getOrganizationTraceMeta({ path, query }),
    sentryApi(
      ctx.viewerEgress,
      origin,
      "sentry.trace.get",
    ).getOrganizationTrace({ path, query }),
  ]);
  const metaData = sentryData(metaResult, REFUSED, "trace meta read");
  const traceData = sentryData(traceResult, REFUSED, "trace read");
  const meta = traceMetaSchema.safeParse(metaData);
  const roots = z.array(traceNodeSchema).safeParse(traceData);
  if (!meta.success || !roots.success) return null;
  return traceCard(link, roots.data, meta.data);
}

/** Read the trace for this viewer, cached per viewer and trace. */
async function viewerTrace(
  ctx: ObjectLinkContext,
  url: URL,
): Promise<{ link: SentryTraceLink; trace: SentryTrace } | null> {
  const link = parseSentryTraceLink(url);
  if (!link) return null;
  const trace = await ctx.cache.getOrLoad(
    // The time window decides what Sentry finds, so it is part of the key.
    `trace:${ctx.viewer.id}:${link.org}/${link.traceId}:${link.timestamp ?? DEFAULT_PERIOD}`,
    async () => {
      const origin = await sentryRegionOrigin(ctx, link.org);
      const value = origin ? await readTrace(ctx, origin, link) : null;
      return { value, ttlMs: TRACE_CACHE_TTL_MS };
    },
  );
  return trace && { link, trace };
}

async function canViewSentryTraceLink(
  ctx: ObjectLinkContext,
  url: URL,
): Promise<boolean> {
  return (await viewerTrace(ctx, url)) !== null;
}

async function resolveSentryTraceLink(
  ctx: ObjectLinkContext,
  url: URL,
): Promise<ObjectAnnotation | undefined> {
  const read = await viewerTrace(ctx, url);
  if (!read) return undefined;
  const { link, trace } = read;
  return {
    kind: "object",
    objectType: "trace",
    key: `trace:${link.org}/${link.traceId}`,
    label: link.traceId.slice(0, 8),
    title: trace.title,
    url: url.href.length <= 2048 ? url.href : null,
    displayType: "Sentry trace",
    facts: trace.facts,
  };
}

/** Sentry trace view links, on sentry.io and customer domains. */
export const sentryTraceLinks: PluginObjectLinkDefinition = {
  canView: canViewSentryTraceLink,
  filters: SENTRY_TRACE_LINK_FILTERS,
  objectType: "trace",
  resolve: resolveSentryTraceLink,
};
