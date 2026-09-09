import { z, type ZodTypeAny } from "zod";
import {
  briefOutcomeStatusSchema,
  buildBriefSearchText,
  conversationBriefSchema,
  type BriefLink,
  type ConversationBrief,
} from "./brief";
import { parseBriefInput, type BriefEntry, type BriefInput } from "./input";

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
          by: z.string().trim().min(1).optional(),
        })
        .strict(),
    ),
    openDecisions: z.array(
      z
        .object({
          text: z.string().trim().min(1),
          owner: z.string().trim().min(1).optional(),
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

type BriefModelRequest = {
  maxTokens?: number;
  modelId: string;
  prompt: string;
  schema: ZodTypeAny;
  system?: string;
  temperature?: number;
};

/** Narrow structured-completion capability required by Brief generation. */
export type BriefCompleteObject = (
  request: BriefModelRequest,
) => Promise<{ costUsd?: number; object: unknown }>;

export type BriefEvidenceCheck = {
  citedUrlCount: number;
  claims: {
    mergedWithoutEvidence: boolean;
  };
  codeChangeCount: number;
  droppedAttributionCount: number;
  droppedRuntimeMarkerCount: number;
  droppedUrls: Array<{ normalized: string; raw: string }>;
  keptUrlCount: number;
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
  model: string;
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
  droppedAttributionCount: number;
  droppedRuntimeMarkerCount: number;
} {
  let droppedAttributionCount = 0;
  let droppedRuntimeMarkerCount = 0;
  const participantNames = new Map(
    args.record.participants.map((participant) => [
      participant.name.toLowerCase(),
      participant.name,
    ]),
  );
  participantNames.set("junior", "Junior");
  const attribution = (value: string | undefined): string | undefined => {
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
    const by = attribution(decision.by);
    return [
      {
        text: truncate(decision.text, 400),
        ...(by ? { by } : undefined),
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
  input: BriefInput;
  previous?: ConversationBrief;
  record: ConversationBrief["record"];
  sizeClass: BriefSizeClass;
  throughIndex: number;
}): string {
  const candidates = inputEntries(args.input, args.throughIndex);
  const messages = candidates.filter((entry) => entry.role !== "tool");
  const tools = candidates.filter((entry) => entry.role === "tool");
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
    codeChanges: args.input.codeChanges,
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
      entries: candidates.filter((entry) => kept.has(entry)),
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

function normalizeCitationUrl(raw: string): string {
  let normalized = raw.trim();
  let previous: string;
  do {
    previous = normalized;
    normalized = normalized.replace(/[;,.)\]]+$/, "");
    normalized = normalized.replace(/\/https?$/i, "");
    normalized = normalized.replace(/\/+$/, "");
  } while (normalized !== previous);
  return normalized;
}

function buildEvidenceLinks(args: {
  input: BriefInput;
  model: ModelBrief;
  previous?: ConversationBrief;
  throughIndex: number;
}): { evidence: BriefEvidenceCheck; links: BriefLink[] } {
  const deterministic = deterministicLinks(args.input);
  const transcriptText = inputEntries(args.input, args.throughIndex)
    .map((entry) => entry.text)
    .join("\n");
  const allowedPriorUrls = new Set(
    (args.previous?.links ?? []).map((link) => normalizeCitationUrl(link.url)),
  );
  const droppedUrls: Array<{ normalized: string; raw: string }> = [];
  const acceptedUrls = new Set<string>();
  const citedLinks: Array<{ link: BriefLink; raw: string }> = [];
  const existingUrls = new Set(
    deterministic.map((link) => normalizeCitationUrl(link.url)),
  );
  for (const citation of args.model.urls) {
    const normalized = normalizeCitationUrl(citation.url);
    const allowed =
      existingUrls.has(normalized) ||
      transcriptText.includes(normalized) ||
      allowedPriorUrls.has(normalized);
    if (!allowed) {
      droppedUrls.push({ raw: citation.url, normalized });
      continue;
    }
    acceptedUrls.add(normalized);
    if (existingUrls.has(normalized)) continue;
    existingUrls.add(normalized);
    citedLinks.push({
      raw: citation.url,
      link: {
        kind: "url",
        label: truncate(citation.label, 400),
        url: normalized,
      },
    });
  }
  const citedLimit = Math.max(0, MAX_LINKS - deterministic.length);
  for (const citation of citedLinks.slice(citedLimit)) {
    droppedUrls.push({
      raw: citation.raw,
      normalized: citation.link.url,
    });
  }
  const links = [
    ...deterministic,
    ...citedLinks.slice(0, citedLimit).map((citation) => citation.link),
  ].slice(0, MAX_LINKS);
  const keptEvidenceUrls = new Set(
    links.map((link) => normalizeCitationUrl(link.url)),
  );
  const uniqueDroppedUrls = [
    ...new Map(
      droppedUrls.map((url) => [`${url.raw}\0${url.normalized}`, url]),
    ).values(),
  ];
  return {
    links,
    evidence: {
      citedUrlCount: args.model.urls.length,
      claims: { mergedWithoutEvidence: false },
      codeChangeCount: args.input.codeChanges.length,
      droppedAttributionCount: 0,
      droppedRuntimeMarkerCount: 0,
      droppedUrls: uniqueDroppedUrls,
      keptUrlCount: [...acceptedUrls].filter((url) => keptEvidenceUrls.has(url))
        .length,
      resourceCount: args.input.resources.length,
    },
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

/** Generate one bounded Brief and attach only deterministic evidence links. */
export async function generateBrief(
  rawArgs: GenerateBriefArgs,
): Promise<GeneratedBrief> {
  const input = parseBriefInput(rawArgs.input);
  if (!Number.isSafeInteger(rawArgs.throughIndex) || rawArgs.throughIndex < 0) {
    throw new Error("throughIndex must be a non-negative integer");
  }
  const record = buildBriefRecord(
    input,
    inputEntries(input, rawArgs.throughIndex),
  );
  const sizeClass = briefSizeClass(record);
  const caps = SIZE_CAPS[sizeClass];
  const result = await rawArgs.completeObject({
    modelId: rawArgs.model,
    schema: modelBriefSchema,
    system: rawArgs.prompt,
    prompt: promptInput({
      caps,
      input,
      previous: rawArgs.previous,
      record,
      sizeClass,
      throughIndex: rawArgs.throughIndex,
    }),
    temperature: 0,
    maxTokens: 2_500,
  });
  const model = modelBriefSchema.parse(result.object);
  const { evidence: linkEvidence, links } = buildEvidenceLinks({
    input,
    model,
    previous: rawArgs.previous,
    throughIndex: rawArgs.throughIndex,
  });
  const normalized = normalizeModelBrief({ caps, links, model, record });
  const mergedClaim = /\bmerged\b/i.test(
    `${normalized.brief.summary}\n${normalized.brief.outcome.text}`,
  );
  const evidence: BriefEvidenceCheck = {
    ...linkEvidence,
    claims: {
      mergedWithoutEvidence: mergedClaim && !hasMergedEvidence(input),
    },
    droppedAttributionCount: normalized.droppedAttributionCount,
    droppedRuntimeMarkerCount: normalized.droppedRuntimeMarkerCount,
  };
  return {
    brief: normalized.brief,
    ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : undefined),
    evidence,
    searchText: buildBriefSearchText(normalized.brief, input.title),
    throughIndex: rawArgs.throughIndex,
  };
}
