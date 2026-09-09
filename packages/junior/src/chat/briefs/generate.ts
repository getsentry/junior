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
  codeChangeCount: number;
  droppedUrls: string[];
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

function optionalTruncated(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  return truncate(value, 400);
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

function normalizeModelBrief(
  model: ModelBrief,
  links: BriefLink[],
): ConversationBrief {
  return conversationBriefSchema.parse({
    schemaVersion: 1,
    summary: truncate(model.summary, 600),
    intent: truncate(model.intent, 400),
    outcome: {
      status: model.outcome.status,
      text: truncate(model.outcome.text, 600),
    },
    decisions: model.decisions.slice(0, 20).map((decision) => ({
      text: truncate(decision.text, 400),
      ...(optionalTruncated(decision.by)
        ? { by: optionalTruncated(decision.by) }
        : undefined),
    })),
    openDecisions: model.openDecisions.slice(0, 20).map((decision) => ({
      text: truncate(decision.text, 400),
      ...(optionalTruncated(decision.owner)
        ? { owner: optionalTruncated(decision.owner) }
        : undefined),
    })),
    facts: uniqueStrings(model.facts, 30),
    links,
    keywords: uniqueStrings(
      model.keywords.map((keyword) => keyword.toLowerCase()),
      12,
    ),
  });
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

function promptInput(args: {
  input: BriefInput;
  previous?: ConversationBrief;
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
    args.previous?.links.map((link) => link.url) ?? [],
  );
  const droppedUrls: string[] = [];
  const acceptedUrls = new Set<string>();
  const citedLinks: BriefLink[] = [];
  const existingUrls = new Set(deterministic.map((link) => link.url));
  for (const citation of args.model.urls) {
    const allowed =
      existingUrls.has(citation.url) ||
      transcriptText.includes(citation.url) ||
      allowedPriorUrls.has(citation.url);
    if (!allowed) {
      droppedUrls.push(citation.url);
      continue;
    }
    acceptedUrls.add(citation.url);
    if (existingUrls.has(citation.url)) continue;
    existingUrls.add(citation.url);
    citedLinks.push({
      kind: "url",
      label: truncate(citation.label, 400),
      url: citation.url,
    });
  }
  const allLinks = [...deterministic, ...citedLinks];
  for (const link of allLinks.slice(MAX_LINKS)) {
    if (link.kind === "url") droppedUrls.push(link.url);
  }
  const links = allLinks.slice(0, MAX_LINKS);
  const uniqueDroppedUrls = [...new Set(droppedUrls)];
  return {
    links,
    evidence: {
      citedUrlCount: args.model.urls.length,
      codeChangeCount: args.input.codeChanges.length,
      droppedUrls: uniqueDroppedUrls,
      keptUrlCount: [...acceptedUrls].filter((url) =>
        links.some((link) => link.url === url),
      ).length,
      resourceCount: args.input.resources.length,
    },
  };
}

/** Generate one bounded Brief and attach only deterministic evidence links. */
export async function generateBrief(
  rawArgs: GenerateBriefArgs,
): Promise<GeneratedBrief> {
  const input = parseBriefInput(rawArgs.input);
  if (!Number.isSafeInteger(rawArgs.throughIndex) || rawArgs.throughIndex < 0) {
    throw new Error("throughIndex must be a non-negative integer");
  }
  const result = await rawArgs.completeObject({
    modelId: rawArgs.model,
    schema: modelBriefSchema,
    system: rawArgs.prompt,
    prompt: promptInput({
      input,
      previous: rawArgs.previous,
      throughIndex: rawArgs.throughIndex,
    }),
    temperature: 0,
    maxTokens: 2_500,
  });
  const model = modelBriefSchema.parse(result.object);
  const { evidence, links } = buildEvidenceLinks({
    input,
    model,
    previous: rawArgs.previous,
    throughIndex: rawArgs.throughIndex,
  });
  const brief = normalizeModelBrief(model, links);
  return {
    brief,
    ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : undefined),
    evidence,
    searchText: buildBriefSearchText(brief, input.title),
    throughIndex: rawArgs.throughIndex,
  };
}
