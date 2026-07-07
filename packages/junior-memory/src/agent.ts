import type { PluginModel } from "@sentry/junior-plugin-api";
import { z } from "zod";
import type {
  MemorySupersessionDecision,
  MemorySupersessionInput,
} from "./store";
import { MEMORY_KINDS, memoryRuntimeContextSchema } from "./types";

const memoryKindSchema = z.enum(MEMORY_KINDS);
const memoryRejectReasonSchema = z.enum([
  "not_public_shareable",
  "secret_or_credential",
  "sensitive_personal",
  "third_party_personal",
  "vague_or_not_self_contained",
  "not_durable",
  "assistant_or_system_detail",
  "unsupported_scope",
]);
const createMemoryRequestSchema = z
  .object({
    content: z.string().min(1),
    expiresAtMs: z.number().finite().optional(),
    runtimeContext: memoryRuntimeContextSchema,
    sourceContext: z
      .object({
        currentUserText: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const extractSessionRequestSchema = z
  .object({
    existingMemories: z
      .array(
        z
          .object({
            content: z.string().min(1),
          })
          .strict(),
      )
      .max(10)
      .default([]),
    runtimeContext: memoryRuntimeContextSchema,
    transcript: z
      .array(
        z.discriminatedUnion("type", [
          z
            .object({
              type: z.literal("message"),
              role: z.enum(["user", "assistant"]),
              text: z.string().min(1),
            })
            .strict(),
          z
            .object({
              type: z.literal("toolResult"),
              toolName: z.string().min(1),
              isError: z.boolean(),
              text: z.string().min(1),
            })
            .strict(),
        ]),
      )
      .min(1),
  })
  .strict();
const supersessionRequestSchema = z
  .object({
    candidate: z
      .object({
        content: z.string().min(1),
        kind: z.literal("preference"),
      })
      .strict(),
    existingMemories: z
      .array(
        z
          .object({
            content: z.string().min(1),
            id: z.string().min(1),
          })
          .strict(),
      )
      .min(1)
      .max(10),
    runtimeContext: memoryRuntimeContextSchema,
  })
  .strict();

const expiresAtMsSchema = z
  .number()
  .finite()
  .nullable()
  .describe(
    "Expiration timestamp when the fact should expire, otherwise null.",
  );
const memoryReviewDecisionSchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal("store"),
      kind: memoryKindSchema,
      content: z.string().min(1),
      expiresAtMs: z.number().finite().optional(),
    })
    .strict(),
  z
    .object({
      decision: z.literal("reject"),
      reason: memoryRejectReasonSchema,
    })
    .strict(),
]);
const memoryReviewResponseSchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal("store"),
      kind: memoryKindSchema.describe(
        "Use preference only for actor-owned personal preferences, opinions, habits, or workflows. Use procedure for reusable task or process instructions. Use knowledge for shared project, channel, operational, or runbook facts.",
      ),
      canonicalFact: z
        .string()
        .min(1)
        .describe(
          "Stored memory text. It must be self-contained and must not include actor names, actor/user labels, source labels, or first- or second-person wording.",
        ),
      expiresAtMs: expiresAtMsSchema,
    })
    .strict(),
  z
    .object({
      decision: z.literal("reject"),
      reason: memoryRejectReasonSchema,
    })
    .strict(),
]);
const extractedMemorySchema = z
  .object({
    kind: memoryKindSchema.describe(
      "Use preference only for actor-owned personal preferences, opinions, habits, or workflows. Use procedure for reusable task or process instructions. Use knowledge for shared project, channel, operational, or runbook facts.",
    ),
    canonicalFact: z
      .string()
      .min(1)
      .describe(
        "Stored memory text as one self-contained fact. It must not include actor names, actor/user labels, source labels, or first- or second-person wording.",
      ),
    expiresAtMs: expiresAtMsSchema,
  })
  .strict();
const extractedMemoryResultSchema = z
  .object({
    content: z.string().min(1),
    expiresAtMs: expiresAtMsSchema,
    kind: memoryKindSchema,
  })
  .strict();
const extractMemoriesResponseSchema = z
  .object({
    memories: z
      .array(extractedMemorySchema)
      .max(5)
      .describe(
        "Accepted public/shareable durable memories from the completed run. Return one object per distinct source assertion and classify it with kind.",
      ),
  })
  .strict();
const supersessionDecisionResponseSchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal("supersedes_old"),
      supersededIds: z.array(z.string().min(1)).min(1).max(10),
    })
    .strict(),
  z
    .object({
      decision: z.enum(["distinct", "uncertain"]),
    })
    .strict(),
]);

type MemoryReviewResponse = z.output<typeof memoryReviewResponseSchema>;
type ExtractMemoriesResponse = z.output<typeof extractMemoriesResponseSchema>;

export type MemoryReview = z.output<typeof memoryReviewDecisionSchema>;

export type CreateMemoryRequest = z.output<typeof createMemoryRequestSchema>;
export type ExtractSessionRequest = z.output<
  typeof extractSessionRequestSchema
>;
export type ExtractedMemory = z.output<typeof extractedMemoryResultSchema>;

export interface MemoryAgent {
  /** Decide whether a new preference safely replaces active old preferences. */
  adjudicateSupersession(
    request: MemorySupersessionInput,
  ): Promise<MemorySupersessionDecision> | MemorySupersessionDecision;
  extractSessionMemories(
    request: ExtractSessionRequest,
  ): Promise<ExtractedMemory[]> | ExtractedMemory[];
  reviewCreateRequest(
    request: CreateMemoryRequest,
  ): Promise<MemoryReview> | MemoryReview;
}

const MEMORY_REVIEW_SYSTEM = [
  "You are Junior's memory review agent.",
  "Review one memory candidate and return one structured review decision.",
  "Store only public/shareable, self-contained facts that are useful beyond this turn.",
  "Reject secrets, credentials, private or sensitive personal details, gossip, speculative claims about other people, assistant/system implementation details, vague references, and low-durability chatter.",
  "Use the runtime context only for authority and scope; do not accept model-provided actor ids, scope ids, aliases, or arbitrary subjects.",
].join("\n");
const MEMORY_EXTRACTION_SYSTEM = [
  "You are Junior's passive memory extraction agent. Return only structured memories worth storing.",
  "Use the completed run transcript as source evidence, including user-authored messages and tool results.",
  "Assistant text is context for interpreting the run, not independent evidence for new facts.",
  "Reject secrets, credentials, private or sensitive personal details, gossip, speculative claims about other people, assistant/system implementation details, vague references, and low-durability chatter.",
  "If no public, durable, self-contained memory remains after rewriting, return an empty memories array.",
].join("\n");
const MEMORY_SUPERSESSION_SYSTEM = [
  "You are Junior's memory supersession agent.",
  "Decide whether a new actor preference clearly replaces existing active actor preferences.",
  "Return supersedes_old only for obvious changed preferences about the same mutable slot.",
  "If the facts are additive, different topics, duplicate, broader/narrower without direct replacement, or uncertain, do not supersede.",
].join("\n");
const CANONICAL_CONTENT_RULES = [
  "- Stored memory text must be a rewritten fact, not copied user wording or a sentence about who said it.",
  "- Store the minimum useful assertion supported by source evidence; do not add adjacent steps, caveats, or generalized advice.",
  "- Do not return both concise and expanded variants of the same source assertion; keep the shortest self-contained canonical memory.",
  "- Put ownership in structured fields, not prose.",
  "- For actor memories, omit the subject and write a stable fact such as 'Prefers X', 'Uses Y', or 'Thinks Z'.",
  "- Drop perspective/provenance markers while preserving useful context.",
  "- Remove actor names, display names, actor/user labels, first- or second-person wording, thread labels, channel labels, and source labels.",
];

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function runtimeDescription(
  request: Pick<CreateMemoryRequest, "expiresAtMs" | "runtimeContext">,
): string {
  const runtime = request.runtimeContext;
  const actor =
    runtime.actor?.platform === "slack"
      ? `slack:${runtime.actor.teamId}:${runtime.actor.userId}`
      : runtime.actor?.platform === "local"
        ? `local:${runtime.actor.userId}`
        : "none";
  const source =
    runtime.source.platform === "slack"
      ? `slack:${runtime.source.teamId}:${runtime.source.channelId}`
      : `local:${runtime.source.conversationId}`;
  const lines = [
    `- actor: ${escapeXml(actor)}`,
    `- source: ${escapeXml(source)}`,
    `- has_conversation: ${runtime.conversationId ? "true" : "false"}`,
    `- expires_at: ${
      request.expiresAtMs === undefined
        ? "never"
        : escapeXml(new Date(request.expiresAtMs).toISOString())
    }`,
  ];
  return ["<runtime>", ...lines, "</runtime>"].join("\n");
}

function sourceContext(request: CreateMemoryRequest): string | undefined {
  const currentUserText = request.sourceContext?.currentUserText?.trim();
  if (!currentUserText) {
    return undefined;
  }
  return [
    "<source-context>",
    "The current user-authored text is source evidence for explicit memory requests. Use it to recover the concrete fact when the candidate is incomplete, vague, or over-personalized. Store only rewritten, self-contained memory content.",
    "<current-user-message>",
    escapeXml(currentUserText),
    "</current-user-message>",
    "</source-context>",
  ].join("\n");
}

function existingMemoriesContext(request: ExtractSessionRequest): string {
  if (request.existingMemories.length === 0) {
    return "<existing-memories>[]</existing-memories>";
  }
  return [
    "<existing-memories>",
    "Use these only to skip memories that are already covered or semantically redundant. They are not source evidence for new memories.",
    escapeXml(JSON.stringify(request.existingMemories)),
    "</existing-memories>",
  ].join("\n");
}

function memoryKindsContext(): string {
  return [
    "<memory-kinds>",
    "- preference: a durable first-person personal preference, opinion, habit, or workflow owned by the current actor. Stored as actor memory.",
    "- procedure: reusable instructions for how a task, lookup, investigation, process, triage flow, or runbook should be done. Store the method, source-of-truth, prerequisite, or decision path when it took effort to discover. Stored as conversation memory.",
    "- knowledge: stable shared project, channel, operational, or runbook fact that is not a personal actor preference. Direct answers to user inquiries qualify only when they are durable beyond this run. Stored as conversation memory.",
    "</memory-kinds>",
  ].join("\n");
}

function reviewPrompt(request: CreateMemoryRequest): string {
  const sections = [
    "<memory-review-input>",
    "Review the candidate memory using the runtime-owned context below.",
    "",
    runtimeDescription(request),
    "",
    sourceContext(request),
    "",
    "<candidate>",
    escapeXml(request.content),
    "</candidate>",
    "",
    "<rules>",
    "- Return store only when the candidate is public/shareable, durable, and self-contained.",
    "- First classify the memory kind: preference, procedure, or knowledge.",
    "- Use kind=preference only for first-person facts authored by the current actor about their own preference, opinion, habit, identity, or workflow.",
    "- Reject named third-person personal facts such as another person's preference, opinion, habit, identity, relationship, or workflow. Do not assume a named person is the current actor.",
    "- Use kind=procedure for reusable task/process/runbook instructions.",
    "- Use kind=knowledge for shared project, channel, operational, or runbook facts.",
    "- When current-user-message contains an explicit memory request with a concrete fact or procedure, extract from current-user-message even if the candidate is vague, incomplete, or phrased as an instruction.",
    "- A candidate may be badly phrased by an outer assistant or extraction pass. When current-user-message contains the actor's own first-person memory fact, treat that as actor-authored source evidence and canonicalize the fact instead of rejecting for third-person wording.",
    "- When candidate wording personalizes a shared task, process, runbook, project, channel, or operational fact, use current-user-message to recover the shared fact and classify it as procedure or knowledge.",
    "- Explicit procedure requests are valid when the source text contains both task context and action. Canonicalize them as shared procedure facts instead of rejecting them as vague.",
    "- Store content as person-less, source-less canonical knowledge. Ownership and source live in structured metadata, not prose.",
    "- For actor memories, omit the subject and write the content as a stable fact such as 'Prefers X', 'Uses Y', or 'Thinks Z'.",
    "- Remove actor names, display names, actor/user labels, first- or second-person wording, thread labels, channel labels, and source labels from stored content.",
    "- Reject third-party personal profile facts, even if they mention a name.",
    "- Reject vague content such as 'remember this' unless the candidate or current-user-message contains the concrete fact.",
    "- Preserve the requested expiration when one exists; otherwise set expiresAtMs to null.",
    "- If unsure, reject.",
    "</rules>",
    "</memory-review-input>",
  ].filter((section): section is string => section !== undefined);
  return sections.join("\n");
}

function runTranscriptContext(request: ExtractSessionRequest): string {
  return [
    "<run-transcript>",
    ...request.transcript.map((entry, index) => {
      if (entry.type === "toolResult") {
        return [
          `<tool-result index="${index}" tool="${escapeXml(entry.toolName)}" is_error="${entry.isError ? "true" : "false"}">`,
          escapeXml(entry.text),
          "</tool-result>",
        ].join("\n");
      }
      return [
        `<message index="${index}" role="${entry.role}">`,
        escapeXml(entry.text),
        "</message>",
      ].join("\n");
    }),
    "</run-transcript>",
  ].join("\n");
}

function sessionExtractionPrompt(request: ExtractSessionRequest): string {
  return [
    "<memory-extraction-input>",
    "Extract durable memories from this completed agent run using the runtime-owned context below.",
    "",
    runtimeDescription({
      runtimeContext: request.runtimeContext,
    }),
    "",
    existingMemoriesContext(request),
    "",
    memoryKindsContext(),
    "",
    runTranscriptContext(request),
    "",
    "<rules>",
    "- Return at most five memories.",
    "- Use user messages and successful tool results as source evidence for storable facts.",
    "- Use failed tool results only when the failure reveals durable process knowledge, not transient errors.",
    "- Use assistant messages only as context; do not store the assistant's claims unless supported by user messages or tool results.",
    "- Return one memory per distinct fact.",
    "- Prefer storing how to achieve a result: stable source-of-truth, query location, workflow, prerequisite, caveat, or reusable decision path that took effort to discover.",
    "- Store direct answers to user inquiries only when they are stable operational/project knowledge, not values that naturally change over time.",
    "- Do not store point-in-time analytics, search, issue, metric, incident, availability, or status answers just because a tool produced them.",
    "- Do not store the fact that the user asked for advice, search, recall, planning, listing, inspection, or removal. Store only stable knowledge discovered in response, such as a reusable method or source-of-truth.",
    "- A user question asking how, what, where, or whether to do something is not source evidence for the answer. Store the answer only when supported by a user-authored factual statement or a tool result.",
    "- Set kind=procedure for reusable task/process/runbook instructions.",
    "- Set kind=knowledge for shared team, project, channel, runbook, or operational facts.",
    "- Set kind=preference only for clear durable first-person facts authored by the current actor about their own preference, opinion, habit, identity, or workflow.",
    "- Reject named third-person personal facts such as another person's preference, opinion, habit, identity, relationship, or workflow. Do not assume a named person is the current actor.",
    "- User-authored task instructions are procedures, not preferences, unless they explicitly describe the actor's personal preference or habit.",
    "- Procedural statements such as 'for X, do Y', 'when X, do Y', and 'to accomplish X, do Y' belong in procedures.",
    ...CANONICAL_CONTENT_RULES,
    "- Skip a candidate when existing-memories already cover the same durable fact.",
    "- Reject third-party personal profile facts, even if they mention a name.",
    "- If unsure, return no memory for that candidate.",
    "</rules>",
    "</memory-extraction-input>",
  ].join("\n");
}

function supersessionPrompt(request: MemorySupersessionInput): string {
  return [
    "<memory-supersession-input>",
    "Decide whether the candidate preference clearly replaces one or more existing active preferences.",
    "",
    runtimeDescription({
      runtimeContext: request.runtimeContext,
    }),
    "",
    "<candidate>",
    escapeXml(JSON.stringify(request.candidate)),
    "</candidate>",
    "",
    "<existing-memories>",
    escapeXml(JSON.stringify(request.existingMemories)),
    "</existing-memories>",
    "",
    "<rules>",
    "- Return supersedes_old only when the candidate and old memory describe the same mutable preference slot and the candidate is the newer value.",
    "- Examples of same mutable slot: preferred programming language, preferred review style, preferred notification cadence, preferred tool for a task.",
    "- Do not supersede when the candidate is just more specific, an additional preference, a different task/context, or the same value phrased differently.",
    "- Do not supersede memories from different topics even if they are both preferences.",
    "- Only return ids that appear in existing-memories.",
    "- If unsure, return uncertain.",
    "</rules>",
    "</memory-supersession-input>",
  ].join("\n");
}

/** Create the memory-owned agent that reviews and extracts memory candidates. */
export function createMemoryAgent(model: PluginModel): MemoryAgent {
  return {
    async adjudicateSupersession(rawRequest) {
      const request = supersessionRequestSchema.parse(
        rawRequest,
      ) as MemorySupersessionInput;
      const result = await model.completeObject({
        schema: supersessionDecisionResponseSchema,
        system: MEMORY_SUPERSESSION_SYSTEM,
        prompt: supersessionPrompt(request),
        maxTokens: 400,
      });
      return supersessionDecisionResponseSchema.parse(
        result.object,
      ) as MemorySupersessionDecision;
    },
    async extractSessionMemories(rawRequest) {
      const request = extractSessionRequestSchema.parse(rawRequest);
      const result = await model.completeObject({
        schema: extractMemoriesResponseSchema,
        system: MEMORY_EXTRACTION_SYSTEM,
        prompt: sessionExtractionPrompt(request),
        maxTokens: 1_000,
      });
      return extractedMemoriesFromResponse(
        extractMemoriesResponseSchema.parse(result.object),
      );
    },
    async reviewCreateRequest(rawRequest) {
      const request = parseCreateMemoryRequest(rawRequest);
      const result = await model.completeObject({
        schema: memoryReviewResponseSchema,
        system: MEMORY_REVIEW_SYSTEM,
        prompt: reviewPrompt(request),
        maxTokens: 700,
      });
      const response = memoryReviewResponseSchema.parse(result.object);
      return memoryReviewFromResponse(response);
    },
  };
}

function memoryReviewFromResponse(
  response: MemoryReviewResponse,
): MemoryReview {
  if (response.decision === "store") {
    return parseMemoryReview({
      decision: "store",
      kind: response.kind,
      content: response.canonicalFact,
      ...(response.expiresAtMs !== null
        ? { expiresAtMs: response.expiresAtMs }
        : {}),
    });
  }
  return parseMemoryReview({
    decision: "reject",
    reason: response.reason,
  });
}

function extractedMemoriesFromResponse(
  response: ExtractMemoriesResponse,
): ExtractedMemory[] {
  const toMemory = (
    memory: z.output<typeof extractedMemorySchema>,
  ): ExtractedMemory =>
    parseExtractedMemory({
      content: memory.canonicalFact,
      expiresAtMs: memory.expiresAtMs,
      kind: memory.kind,
    });
  return response.memories.map(toMemory);
}

/** Parse the canonical extracted-memory shape stored across task retries. */
export function parseExtractedMemory(memory: unknown): ExtractedMemory {
  return extractedMemoryResultSchema.parse(memory);
}

/** Parse the structured decision returned by the memory agent. */
export function parseMemoryReview(result: unknown): MemoryReview {
  return memoryReviewDecisionSchema.parse(result);
}

/** Parse the structured input sent to the memory agent. */
export function parseCreateMemoryRequest(
  request: unknown,
): CreateMemoryRequest {
  return createMemoryRequestSchema.parse(request);
}
