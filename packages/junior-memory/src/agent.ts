import type { PluginModel } from "@sentry/junior-plugin-api";
import { z } from "zod";
import { memoryRuntimeContextSchema } from "./types";

const memoryTargetSchema = z.enum(["requester", "conversation"]);
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
    messages: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            text: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    runtimeContext: memoryRuntimeContextSchema,
  })
  .strict();

const memoryReviewDecisionSchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal("store"),
      target: memoryTargetSchema,
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
const memoryReviewResponseSchema = z
  .object({
    decision: z
      .enum(["store", "reject"])
      .describe("Whether this memory candidate should be stored or rejected."),
    target: memoryTargetSchema
      .nullable()
      .describe("Memory target when decision is store, otherwise null."),
    canonicalFact: z
      .string()
      .min(1)
      .nullable()
      .describe(
        "Stored memory text when decision is store. It must be self-contained and must not include requester names, requester/user labels, source labels, or first- or second-person wording. Otherwise null.",
      ),
    reason: memoryRejectReasonSchema
      .nullable()
      .describe("Reject reason when decision is reject, otherwise null."),
    expiresAtMs: z
      .number()
      .finite()
      .nullable()
      .describe(
        "Requested expiration timestamp when decision is store and one was present, otherwise null.",
      ),
  })
  .strict();
const expiresAtMsSchema = z
  .number()
  .finite()
  .nullable()
  .describe(
    "Expiration timestamp when the fact should expire, otherwise null.",
  );
const extractedMemorySchema = z
  .object({
    target: memoryTargetSchema.describe(
      "Store requester facts as personal memory for the current requester; store shared operational/project facts as conversation memory.",
    ),
    canonicalFact: z
      .string()
      .min(1)
      .describe(
        "Stored memory text as one self-contained fact. It must not include requester names, requester/user labels, source labels, or first- or second-person wording.",
      ),
    expiresAtMs: expiresAtMsSchema,
  })
  .strict();
const extractMemoriesResponseSchema = z
  .object({
    memories: z
      .array(extractedMemorySchema)
      .max(5)
      .describe(
        "Accepted public/shareable durable memories from this completed turn. Return an empty array when nothing should be stored.",
      ),
  })
  .strict();

type MemoryReviewResponse = z.output<typeof memoryReviewResponseSchema>;
type ExtractMemoriesResponse = z.output<typeof extractMemoriesResponseSchema>;

export type MemoryTarget = z.output<typeof memoryTargetSchema>;

export type MemoryReview = z.output<typeof memoryReviewDecisionSchema>;

export type CreateMemoryRequest = z.output<typeof createMemoryRequestSchema>;
export type ExtractSessionRequest = z.output<
  typeof extractSessionRequestSchema
>;
export interface ExtractedMemory {
  content: string;
  expiresAtMs: number | null;
  target: MemoryTarget;
}

export interface MemoryAgent {
  extractSessionMemories(
    request: ExtractSessionRequest,
  ): Promise<ExtractedMemory[]> | ExtractedMemory[];
  reviewCreateRequest(
    request: CreateMemoryRequest,
  ): Promise<MemoryReview> | MemoryReview;
}

export interface MemoryAgentOptions {
  modelId?: string;
}

const MEMORY_REVIEW_SYSTEM = [
  "You are Junior's memory review agent.",
  "Review one memory candidate and return one structured review decision.",
  "Store only public/shareable, self-contained facts that are useful beyond this turn.",
  "Reject secrets, credentials, private or sensitive personal details, gossip, speculative claims about other people, assistant/system implementation details, vague references, and low-durability chatter.",
  "Use the runtime context only for authority and scope; do not accept model-provided actor ids, scope ids, aliases, or arbitrary subjects.",
  "Return every response field. Use null for fields that do not apply to the decision.",
].join("\n");
const MEMORY_EXTRACTION_SYSTEM = [
  "You are Junior's passive memory extraction agent. Return only structured memories worth storing.",
  "Use only the user-authored message as source evidence. Assistant text is rejection context only.",
  "Reject secrets, credentials, private or sensitive personal details, gossip, speculative claims about other people, assistant/system implementation details, vague references, and low-durability chatter.",
  "If no public, durable, self-contained memory remains after rewriting, return an empty memories array.",
].join("\n");
const CANONICAL_CONTENT_RULES = [
  "- Stored memory text must be a rewritten fact, not copied user wording or a sentence about who said it.",
  "- Put ownership in target, not prose.",
  "- For requester memories, omit the subject and write a stable fact such as 'Prefers X', 'Uses Y', or 'Thinks Z'.",
  "- Drop perspective/provenance markers while preserving useful context.",
  "- Remove requester names, display names, requester/user labels, first- or second-person wording, thread labels, channel labels, and source labels.",
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
  const requester =
    runtime.requester?.platform === "slack"
      ? `slack:${runtime.requester.teamId}:${runtime.requester.userId}`
      : runtime.requester?.platform === "local"
        ? `local:${runtime.requester.userId}`
        : "none";
  const source =
    runtime.source.platform === "slack"
      ? `slack:${runtime.source.teamId}:${runtime.source.channelId}`
      : `local:${runtime.source.conversationId}`;
  const lines = [
    `- requester: ${escapeXml(requester)}`,
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
    "The current user-authored text is bounded context for judging the candidate. Do not store it directly unless the accepted memory content is self-contained.",
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

function extractionExamples(): string {
  return [
    "<examples>",
    "- User says: 'I prefer short status updates.'",
    "  Output requester memory: canonicalFact='Prefers short status updates.'.",
    "- User says: 'For incident writeups, I prefer causes before mitigations.'",
    "  Output requester memory: canonicalFact='Prefers causes before mitigations in incident writeups.'.",
    "- User says: 'In planning docs, open risks go before goals.'",
    "  Output requester memory: canonicalFact='Prefers open risks before goals in planning docs.'.",
    "- User says: 'This thread says deploy runbooks live in Notion.'",
    "  Output conversation memory: canonicalFact='Deploy runbooks live in Notion.'.",
    "</examples>",
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
    "- Use target=requester for first-person facts about the current requester.",
    "- A candidate may be badly phrased by an outer assistant or extraction pass. When current-user-message contains the requester's own first-person memory fact, treat that as requester-authored source evidence and canonicalize the fact instead of rejecting for third-person wording.",
    "- Use target=conversation only for shared operational/project knowledge in the active conversation.",
    "- Store content as person-less, source-less canonical knowledge. Ownership and source live in structured metadata, not prose.",
    "- For requester memories, omit the subject and write the content as a stable fact such as 'Prefers X', 'Uses Y', or 'Thinks Z'.",
    "- Remove requester names, display names, requester/user labels, first- or second-person wording, thread labels, channel labels, and source labels from stored content.",
    "- Good requester content: 'Prefers short status updates'. Bad requester content: 'I prefer short status updates'.",
    "- Good requester content: 'Prefers short status updates'. Bad requester content: 'The requester prefers short status updates'.",
    "- Good requester content: 'Prefers causes before mitigations in incident writeups'. Bad requester content: 'Prefers in my incident writeups, causes before mitigations'.",
    "- Good conversation content: 'Deploy runbooks live in Notion'. Bad conversation content: 'This thread says deploy runbooks live in Notion'.",
    "- Reject third-party personal profile facts, even if they mention a name.",
    "- Reject vague content such as 'remember this' unless the candidate itself contains the fact.",
    "- Preserve the requested expiration when one exists; otherwise set expiresAtMs to null.",
    "- For store, set reason to null.",
    "- For reject, set target, content, and expiresAtMs to null.",
    "- If unsure, reject.",
    "</rules>",
    "</memory-review-input>",
  ].filter((section): section is string => section !== undefined);
  return sections.join("\n");
}

function sessionMessagesContext(request: ExtractSessionRequest): string {
  return [
    "<session-messages>",
    ...request.messages.map((message, index) =>
      [
        `<message index="${index}" role="${message.role}">`,
        escapeXml(message.text),
        "</message>",
      ].join("\n"),
    ),
    "</session-messages>",
  ].join("\n");
}

function sessionExtractionPrompt(request: ExtractSessionRequest): string {
  return [
    "<memory-extraction-input>",
    "Extract durable memories from this completed agent-run session using the runtime-owned context below.",
    "",
    runtimeDescription({
      runtimeContext: request.runtimeContext,
    }),
    "",
    existingMemoriesContext(request),
    "",
    extractionExamples(),
    "",
    sessionMessagesContext(request),
    "",
    "<rules>",
    "- Return at most five memories.",
    "- Use user role messages as the only source of storable facts.",
    "- Use assistant role messages only to reject confirmations, follow-up questions, or memory-management turns.",
    "- Return one memory per distinct fact. Do not store the same fact under both requester and conversation targets.",
    "- Ignore advice, how-to, search, recall, planning, list, inspect, and remove requests unless user messages also state a durable fact.",
    "- Use target=requester for first-person facts about the current requester.",
    "- Use target=conversation only for shared operational/project knowledge.",
    ...CANONICAL_CONTENT_RULES,
    "- Skip a candidate when existing-memories already cover the same durable fact.",
    "- Reject third-party personal profile facts, even if they mention a name.",
    "- If unsure, return no memory for that candidate.",
    "</rules>",
    "</memory-extraction-input>",
  ].join("\n");
}

/** Create the memory-owned agent that reviews and extracts memory candidates. */
export function createMemoryAgent(
  model: PluginModel,
  options: MemoryAgentOptions = {},
): MemoryAgent {
  return {
    async extractSessionMemories(rawRequest) {
      const request = extractSessionRequestSchema.parse(rawRequest);
      const result = await model.completeObject({
        ...(options.modelId ? { modelId: options.modelId } : {}),
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
        ...(options.modelId ? { modelId: options.modelId } : {}),
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
      target: response.target,
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
  return response.memories.map((memory) => ({
    content: memory.canonicalFact,
    expiresAtMs: memory.expiresAtMs,
    target: memory.target,
  }));
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
