import { z, type ZodTypeAny } from "zod";
import {
  briefOutcomeStatusSchema,
  conversationBriefSchema,
  parseBriefInput,
  type BriefEntry,
  type BriefInput,
  type BriefLink,
  type ConversationBrief,
} from "./schema";

const MAX_INPUT_CHARS = 60_000;
const MAX_MESSAGE_TEXT_CHARS = 4_000;
const MAX_TOOL_TEXT_CHARS = 1_500;
const MAX_LINKS = 40;

const SIZE_CAPS = {
  small: { decisions: 3, openDecisions: 2, facts: 5, keywords: 5 },
  medium: { decisions: 8, openDecisions: 5, facts: 10, keywords: 8 },
  large: { decisions: 20, openDecisions: 10, facts: 15, keywords: 12 },
} as const;

type BriefSizeClass = keyof typeof SIZE_CAPS;
type BriefSizeCaps = (typeof SIZE_CAPS)[BriefSizeClass];

const modelBriefSchema = z
  .object({
    summary: z.string().trim().min(1),
    intent: z.string().trim().min(1),
    outcome: z
      .object({
        status: briefOutcomeStatusSchema,
        text: z.string().trim().min(1),
      })
      .strict(),
    decisions: z.array(
      z
        .object({
          text: z.string().trim().min(1),
          by: z.string().trim().min(1).nullable().default(null),
          kind: z.enum(["stated", "confirmed", "assumed"]),
        })
        .strict(),
    ),
    openDecisions: z.array(
      z
        .object({
          text: z.string().trim().min(1),
          owner: z.string().trim().min(1).nullable().default(null),
        })
        .strict(),
    ),
    facts: z.array(z.string().trim().min(1)),
    keywords: z.array(z.string().trim().min(1)),
    urls: z.array(
      z
        .object({
          label: z.string().trim().min(1),
          url: z.string().url().max(2_048),
        })
        .strict(),
    ),
  })
  .strict();

type ModelBrief = z.output<typeof modelBriefSchema>;

/** Structured completion for one Brief. The caller binds the model. */
type BriefCompleteObject = (request: {
  maxTokens: number;
  prompt: string;
  schema: ZodTypeAny;
  system: string;
  temperature: number;
}) => Promise<{ costUsd?: number; object: unknown }>;

/** Evidence-check diagnostics, rendered by the local replay CLI. */
export type BriefEvidenceCheck = {
  citedUrlCount: number;
  codeChangeCount: number;
  coercedDecisionKinds: number;
  droppedAttributionCount: number;
  droppedRuntimeMarkerCount: number;
  droppedUrls: Array<{ normalized: string; raw: string }>;
  keptUrlCount: number;
  mergedClaimWithoutEvidence: boolean;
  resourceCount: number;
};

export type GeneratedBrief = {
  brief: ConversationBrief;
  costUsd?: number;
  evidence: BriefEvidenceCheck;
  searchText: string;
  throughIndex: number;
};

export type GenerateBriefArgs = {
  completeObject: BriefCompleteObject;
  input: BriefInput;
  previous?: ConversationBrief;
  prompt: string;
  throughIndex: number;
};

function truncate(value: string, limit: number): string {
  const trimmed = value.trim();
  return trimmed.length <= limit ? trimmed : trimmed.slice(0, limit);
}

function truncateSentence(value: string, limit: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= limit) return trimmed;
  const bounded = trimmed.slice(0, limit);
  const boundary = Math.max(
    bounded.lastIndexOf("."),
    bounded.lastIndexOf("!"),
    bounded.lastIndexOf("?"),
  );
  if (boundary + 1 >= limit * 0.6) {
    return bounded.slice(0, boundary + 1).trim();
  }
  return `${trimmed.slice(0, limit - 1).trimEnd()}…`;
}

function uniqueStrings(values: string[], limit: number): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const normalized = truncate(value, 400);
    if (normalized) unique.add(normalized);
    if (unique.size === limit) break;
  }
  return [...unique];
}

const RUNTIME_MARKER_PATTERN =
  /\[\[NO_REPLY\]\]|<\/?(?:active-asks|analysis-error|available-skills|brief-input|compaction|current-instruction|image-attachment|omitted-image-attachments|pi-history|plugin-contribution|resolved-or-replaced-asks|runtime-turn-context|thread-compactions|thread-context|turn-context)\b/i;

function hasRuntimeMarker(value: string): boolean {
  return RUNTIME_MARKER_PATTERN.test(value);
}

function normalizeModelBrief(args: {
  caps: BriefSizeCaps;
  links: BriefLink[];
  model: ModelBrief;
  record: ConversationBrief["record"];
}): {
  brief: ConversationBrief;
  coercedDecisionKinds: number;
  droppedAttributionCount: number;
  droppedRuntimeMarkerCount: number;
} {
  let coercedDecisionKinds = 0;
  let droppedAttributionCount = 0;
  let droppedRuntimeMarkerCount = 0;
  const participantNames = new Map(
    args.record.participants.map((participant) => [
      participant.name.toLowerCase(),
      participant.name,
    ]),
  );
  participantNames.set("junior", "Junior");
  const attribution = (
    value: string | null | undefined,
  ): string | undefined => {
    if (!value?.trim()) return undefined;
    const matched = participantNames.get(value.trim().toLowerCase());
    if (!matched) droppedAttributionCount += 1;
    return matched;
  };
  const decisions = args.model.decisions.flatMap((decision) => {
    if (hasRuntimeMarker(decision.text)) {
      droppedRuntimeMarkerCount += 1;
      return [];
    }
    let by = attribution(decision.by);
    let kind = decision.kind;
    if (by === "Junior" && kind !== "assumed") {
      // Junior cannot state or confirm a decision for a human.
      kind = "assumed";
      coercedDecisionKinds += 1;
    } else if (by && by !== "Junior" && kind === "assumed") {
      // A human named on an assumed decision is not evidence of acceptance.
      by = undefined;
      coercedDecisionKinds += 1;
    }
    return [
      {
        text: truncate(decision.text, 400),
        ...(by ? { by } : undefined),
        kind,
      },
    ];
  });
  const openDecisions = args.model.openDecisions.flatMap((decision) => {
    if (hasRuntimeMarker(decision.text)) {
      droppedRuntimeMarkerCount += 1;
      return [];
    }
    const owner = attribution(decision.owner);
    return [
      {
        text: truncate(decision.text, 400),
        ...(owner ? { owner } : undefined),
      },
    ];
  });
  const facts = args.model.facts.filter((fact) => {
    const keep = !hasRuntimeMarker(fact);
    if (!keep) droppedRuntimeMarkerCount += 1;
    return keep;
  });

  return {
    brief: conversationBriefSchema.parse({
      schemaVersion: 1,
      record: args.record,
      summary: truncateSentence(args.model.summary, 600),
      intent: truncateSentence(args.model.intent, 400),
      outcome: {
        status: args.model.outcome.status,
        text: truncateSentence(args.model.outcome.text, 600),
      },
      decisions: decisions.slice(0, args.caps.decisions),
      openDecisions: openDecisions.slice(0, args.caps.openDecisions),
      facts: uniqueStrings(facts, args.caps.facts),
      links: args.links,
      keywords: uniqueStrings(
        args.model.keywords.map((keyword) => keyword.toLowerCase()),
        args.caps.keywords,
      ),
    }),
    coercedDecisionKinds,
    droppedAttributionCount,
    droppedRuntimeMarkerCount,
  };
}

function inputEntries(input: BriefInput, throughIndex: number): BriefEntry[] {
  return input.entries
    .filter((entry) => entry.index <= throughIndex)
    .map((entry) => {
      const limit =
        entry.role === "tool" ? MAX_TOOL_TEXT_CHARS : MAX_MESSAGE_TEXT_CHARS;
      return {
        ...entry,
        text:
          entry.text.length > limit
            ? `${entry.text.slice(0, limit - 1)}…`
            : entry.text,
      };
    });
}

function buildBriefRecord(
  input: BriefInput,
  entries: BriefEntry[],
): ConversationBrief["record"] {
  if (entries.length === 0) {
    throw new Error("A Brief requires at least one entry through its index");
  }
  const participantByName = new Map<
    string,
    { messages: number; name: string }
  >();
  for (const entry of entries) {
    if (entry.role !== "user" || !entry.author?.trim()) continue;
    const key = entry.author.trim().toLowerCase();
    const participant = participantByName.get(key);
    if (participant) {
      participant.messages += 1;
    } else {
      participantByName.set(key, { name: entry.author.trim(), messages: 1 });
    }
  }
  const activityTimes = entries.map((entry) => entry.createdAtMs);
  const startedAtMs = Math.min(...activityTimes);
  const lastActivityAtMs = Math.max(...activityTimes);
  const turns = new Set(
    entries.flatMap((entry) => (entry.turnId ? [entry.turnId] : [])),
  ).size;
  return {
    startedAt: new Date(startedAtMs).toISOString(),
    lastActivityAt: new Date(lastActivityAtMs).toISOString(),
    durationMs: lastActivityAtMs - startedAtMs,
    participants: [...participantByName.values()],
    userMessages: entries.filter((entry) => entry.role === "user").length,
    assistantMessages: entries.filter((entry) => entry.role === "assistant")
      .length,
    toolResults: entries.filter((entry) => entry.role === "tool").length,
    events: entries.filter((entry) => entry.role === "event").length,
    ...(turns > 0 ? { turns } : undefined),
    ...(input.location ? { location: input.location } : undefined),
    codeChanges: input.codeChanges,
  };
}

function briefSizeClass(record: ConversationBrief["record"]): BriefSizeClass {
  if (record.userMessages <= 3) return "small";
  if (record.userMessages <= 12) return "medium";
  return "large";
}

function promptInput(args: {
  caps: BriefSizeCaps;
  entries: BriefEntry[];
  input: BriefInput;
  previous?: ConversationBrief;
  record: ConversationBrief["record"];
  sizeClass: BriefSizeClass;
}): string {
  const messages = args.entries.filter((entry) => entry.role !== "tool");
  const tools = args.entries.filter((entry) => entry.role === "tool");
  const keptMessages = [...messages];
  const keptTools: BriefEntry[] = [];
  const base = {
    conversation: {
      id: args.input.conversationId,
      title: args.input.title,
      visibility: args.input.visibility,
      location: args.input.location,
    },
    record: args.record,
    sizeClass: args.sizeClass,
    caps: args.caps,
    previousBrief: args.previous,
    resources: args.input.resources,
  };
  const serialize = (): string => {
    const kept = new Set([...keptMessages, ...keptTools]);
    return JSON.stringify({
      ...base,
      omitted: {
        messages: messages.length - keptMessages.length,
        toolResults: tools.length - keptTools.length,
      },
      entries: args.entries.filter((entry) => kept.has(entry)),
    });
  };

  let text = serialize();
  while (text.length > MAX_INPUT_CHARS && keptMessages.length > 0) {
    keptMessages.shift();
    text = serialize();
  }
  if (text.length > MAX_INPUT_CHARS) {
    throw new Error("Brief metadata exceeds the 60,000 character input limit");
  }

  for (let index = tools.length - 1; index >= 0; index -= 1) {
    keptTools.push(tools[index]!);
    const candidate = serialize();
    if (candidate.length <= MAX_INPUT_CHARS) {
      text = candidate;
    } else {
      keptTools.pop();
    }
  }

  return [
    "<brief-input>",
    text,
    "</brief-input>",
    "Return the next Brief as structured data.",
  ].join("\n");
}

function deterministicLinks(input: BriefInput): BriefLink[] {
  return [
    ...input.codeChanges.map((change) => ({
      kind: "code_change" as const,
      label: truncate(
        `${change.repository}#${change.number}${change.title ? ` · ${change.title}` : ""}`,
        400,
      ),
      url: change.url,
      status: change.state,
    })),
    ...input.resources.map((resource) => ({
      kind: "resource" as const,
      label: truncate(resource.label, 400),
      url: resource.url,
      ...(resource.status ? { status: resource.status } : undefined),
    })),
  ];
}

function decodeHtmlEntities(value: string): string {
  const entities: Record<string, string> = {
    "&#39;": "'",
    "&amp;": "&",
    "&gt;": ">",
    "&lt;": "<",
    "&quot;": '"',
  };
  return value.replace(
    /&(?:amp|lt|gt|quot|#39);/g,
    (entity) => entities[entity]!,
  );
}

function endsWithUnopenedBracket(
  url: string,
  open: string,
  close: string,
): boolean {
  return (
    url.endsWith(close) && url.split(open).length < url.split(close).length
  );
}

/**
 * Strip punctuation that prose attaches to a URL. A closing bracket stays when
 * the URL opened it, so `wiki/Foo_(bar)` survives and `(see https://x/y)` does not.
 */
function normalizeCitationUrl(raw: string): string {
  let url = decodeHtmlEntities(raw).trim();
  for (;;) {
    let next = url.replace(/[;,.]+$/, "").replace(/\/+$/, "");
    if (
      endsWithUnopenedBracket(next, "(", ")") ||
      endsWithUnopenedBracket(next, "[", "]")
    ) {
      next = next.slice(0, -1);
    }
    if (next === url) return url;
    url = next;
  }
}

/** Models sometimes append a stray `/https` to a cited URL; try without it. */
function citationCandidates(raw: string): string[] {
  const normalized = normalizeCitationUrl(raw);
  const stripped = normalizeCitationUrl(normalized.replace(/\/https?$/i, ""));
  return stripped === normalized ? [normalized] : [normalized, stripped];
}

/** URL tokens in prose or Slack `<url|label>` links, normalized for matching. */
function normalizedUrlTokens(value: string): Set<string> {
  const tokens = decodeHtmlEntities(value).match(/https?:\/\/[^\s<>"'|]+/gi);
  return new Set(
    (tokens ?? []).map(normalizeCitationUrl).filter((url) => url.length > 0),
  );
}

function buildEvidenceLinks(args: {
  entries: BriefEntry[];
  input: BriefInput;
  model: ModelBrief;
  previous?: ConversationBrief;
}): {
  droppedUrls: BriefEvidenceCheck["droppedUrls"];
  keptUrlCount: number;
  links: BriefLink[];
} {
  const deterministic = deterministicLinks(args.input);
  const transcriptUrls = normalizedUrlTokens(
    args.entries.map((entry) => entry.text).join("\n"),
  );
  const priorUrls = new Set(
    (args.previous?.links ?? []).map((link) => normalizeCitationUrl(link.url)),
  );
  const linkedUrls = new Set(
    deterministic.map((link) => normalizeCitationUrl(link.url)),
  );
  const supportedUrls = new Set<string>();
  const droppedUrls = new Map<string, { normalized: string; raw: string }>();
  const cited: Array<{ link: BriefLink; raw: string }> = [];
  for (const citation of args.model.urls) {
    const candidates = citationCandidates(citation.url);
    const normalized = candidates.find(
      (candidate) =>
        linkedUrls.has(candidate) ||
        transcriptUrls.has(candidate) ||
        priorUrls.has(candidate),
    );
    if (normalized === undefined) {
      droppedUrls.set(`${citation.url}\0${candidates[0]}`, {
        normalized: candidates[0]!,
        raw: citation.url,
      });
      continue;
    }
    supportedUrls.add(normalized);
    if (linkedUrls.has(normalized)) continue;
    linkedUrls.add(normalized);
    cited.push({
      raw: citation.url,
      link: {
        kind: "url",
        label: truncate(citation.label, 400),
        url: normalized,
      },
    });
  }
  const citedLimit = Math.max(0, MAX_LINKS - deterministic.length);
  for (const citation of cited.slice(citedLimit)) {
    droppedUrls.set(`${citation.raw}\0${citation.link.url}`, {
      normalized: citation.link.url,
      raw: citation.raw,
    });
  }
  const links = [
    ...deterministic,
    ...cited.slice(0, citedLimit).map((citation) => citation.link),
  ].slice(0, MAX_LINKS);
  const keptUrls = new Set(links.map((link) => normalizeCitationUrl(link.url)));
  return {
    droppedUrls: [...droppedUrls.values()],
    keptUrlCount: [...supportedUrls].filter((url) => keptUrls.has(url)).length,
    links,
  };
}

function hasMergedEvidence(input: BriefInput): boolean {
  return (
    input.codeChanges.some((change) => change.state === "merged") ||
    input.resources.some(
      (resource) => resource.status?.trim().toLowerCase() === "merged",
    )
  );
}

/** Build the text indexed for a Brief without adding transcript content. */
function buildBriefSearchText(
  brief: ConversationBrief,
  title?: string,
): string {
  return [
    title,
    brief.summary,
    brief.intent,
    brief.outcome.text,
    ...brief.decisions.map((decision) => decision.text),
    ...brief.openDecisions.map((decision) => decision.text),
    ...brief.facts,
    ...brief.keywords,
    ...brief.links.map((link) => link.label),
    ...brief.record.participants.map((participant) => participant.name),
    ...brief.record.codeChanges.map(
      (change) => `${change.repository}#${change.number} ${change.state}`,
    ),
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n");
}

/** Generate one bounded Brief and attach only deterministic evidence links. */
export async function generateBrief(
  args: GenerateBriefArgs,
): Promise<GeneratedBrief> {
  const input = parseBriefInput(args.input);
  if (!Number.isSafeInteger(args.throughIndex) || args.throughIndex < 0) {
    throw new Error("throughIndex must be a non-negative integer");
  }
  const entries = inputEntries(input, args.throughIndex);
  const record = buildBriefRecord(input, entries);
  const sizeClass = briefSizeClass(record);
  const caps = SIZE_CAPS[sizeClass];
  const result = await args.completeObject({
    maxTokens: 2_500,
    prompt: promptInput({
      caps,
      entries,
      input,
      previous: args.previous,
      record,
      sizeClass,
    }),
    schema: modelBriefSchema,
    system: args.prompt,
    temperature: 0,
  });
  const model = modelBriefSchema.parse(result.object);
  const { droppedUrls, keptUrlCount, links } = buildEvidenceLinks({
    entries,
    input,
    model,
    previous: args.previous,
  });
  const normalized = normalizeModelBrief({ caps, links, model, record });
  const mergedClaim = /\bmerged\b/i.test(
    `${normalized.brief.summary}\n${normalized.brief.outcome.text}`,
  );
  const hasLinkedEvidence =
    input.codeChanges.length > 0 || input.resources.length > 0;
  return {
    brief: normalized.brief,
    ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : undefined),
    evidence: {
      citedUrlCount: model.urls.length,
      codeChangeCount: input.codeChanges.length,
      coercedDecisionKinds: normalized.coercedDecisionKinds,
      droppedAttributionCount: normalized.droppedAttributionCount,
      droppedRuntimeMarkerCount: normalized.droppedRuntimeMarkerCount,
      droppedUrls,
      keptUrlCount,
      mergedClaimWithoutEvidence:
        mergedClaim && hasLinkedEvidence && !hasMergedEvidence(input),
      resourceCount: input.resources.length,
    },
    searchText: buildBriefSearchText(normalized.brief, input.title),
    throughIndex: args.throughIndex,
  };
}
