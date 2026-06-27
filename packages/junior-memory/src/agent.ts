import type { PluginModel } from "@sentry/junior-plugin-api";
import { z } from "zod";
import { memoryRuntimeContextSchema } from "./types";

const memoryTargetSchema = z.enum(["requester", "conversation"]);
const memoryKindSchema = z.enum(["preference", "procedure", "fact"]);
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
const memoryReviewResponseSchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal("store"),
      kind: memoryKindSchema.describe(
        "Use preference only for requester-owned personal preferences, opinions, habits, or workflows. Use procedure for reusable task or process instructions. Use fact for shared project, channel, operational, or runbook knowledge.",
      ),
      canonicalFact: z
        .string()
        .min(1)
        .describe(
          "Stored memory text. It must be self-contained and must not include requester names, requester/user labels, source labels, or first- or second-person wording.",
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
    procedures: z
      .array(extractedMemorySchema)
      .max(5)
      .describe(
        "Reusable public/shareable task, process, triage-flow, or runbook instructions from this completed turn. These are stored as conversation memory.",
      ),
    facts: z
      .array(extractedMemorySchema)
      .max(5)
      .describe(
        "Public/shareable shared project, channel, operational, or runbook facts from this completed turn. These are stored as conversation memory.",
      ),
    preferences: z
      .array(extractedMemorySchema)
      .max(5)
      .describe(
        "Durable public/shareable personal preferences, opinions, habits, or workflows explicitly owned by the current requester. These are stored as requester memory.",
      ),
  })
  .strict();

type MemoryReviewResponse = z.output<typeof memoryReviewResponseSchema>;
type ExtractMemoriesResponse = z.output<typeof extractMemoriesResponseSchema>;

export type MemoryTarget = z.output<typeof memoryTargetSchema>;
type MemoryKind = z.output<typeof memoryKindSchema>;

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

const MEMORY_REVIEW_SYSTEM = [
  "You are Junior's memory review agent.",
  "Review one memory candidate and return one structured review decision.",
  "Store only public/shareable, self-contained facts that are useful beyond this turn.",
  "Reject secrets, credentials, private or sensitive personal details, gossip, speculative claims about other people, assistant/system implementation details, vague references, and low-durability chatter.",
  "Use the runtime context only for authority and scope; do not accept model-provided actor ids, scope ids, aliases, or arbitrary subjects.",
].join("\n");
const MEMORY_EXTRACTION_SYSTEM = [
  "You are Junior's passive memory extraction agent. Return only structured memories worth storing.",
  "Use only the user-authored message as source evidence. Assistant text is rejection context only.",
  "Reject secrets, credentials, private or sensitive personal details, gossip, speculative claims about other people, assistant/system implementation details, vague references, and low-durability chatter.",
  "If no public, durable, self-contained memory remains after rewriting, return an empty memories array.",
].join("\n");
const CANONICAL_CONTENT_RULES = [
  "- Stored memory text must be a rewritten fact, not copied user wording or a sentence about who said it.",
  "- Put ownership in structured fields, not prose.",
  "- For requester memories, omit the subject and write a stable fact such as 'Prefers X', 'Uses Y', or 'Thinks Z'.",
  "- Drop perspective/provenance markers while preserving useful context.",
  "- Remove requester names, display names, requester/user labels, first- or second-person wording, thread labels, channel labels, and source labels.",
];

function targetForKind(kind: MemoryKind): MemoryTarget {
  if (kind === "preference") {
    return "requester";
  }
  return "conversation";
}

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
    "- preference: a durable personal preference, opinion, habit, or workflow owned by the current requester. Stored as requester memory.",
    "- procedure: reusable instructions for how a task, process, triage flow, or runbook should be done. Stored as conversation memory.",
    "- fact: shared project, channel, operational, or runbook knowledge that is not a personal requester preference. Stored as conversation memory.",
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
    "- First classify the memory kind: preference, procedure, or fact.",
    "- Use kind=preference only for facts about the current requester as a person/user, such as their own preference, opinion, habit, identity, or workflow.",
    "- Use kind=procedure for reusable task/process/runbook instructions.",
    "- Use kind=fact for shared project, channel, operational, or runbook knowledge.",
    "- When current-user-message contains an explicit memory request with a concrete fact or procedure, extract from current-user-message even if the candidate is vague, incomplete, or phrased as an instruction.",
    "- A candidate may be badly phrased by an outer assistant or extraction pass. When current-user-message contains the requester's own first-person memory fact, treat that as requester-authored source evidence and canonicalize the fact instead of rejecting for third-person wording.",
    "- When candidate wording personalizes a shared task, process, runbook, project, channel, or operational fact, use current-user-message to recover the shared fact and classify it as procedure or fact.",
    "- Explicit procedure requests are valid when the source text contains both task context and action. Canonicalize them as shared procedure facts instead of rejecting them as vague.",
    "- Store content as person-less, source-less canonical knowledge. Ownership and source live in structured metadata, not prose.",
    "- For requester memories, omit the subject and write the content as a stable fact such as 'Prefers X', 'Uses Y', or 'Thinks Z'.",
    "- Remove requester names, display names, requester/user labels, first- or second-person wording, thread labels, channel labels, and source labels from stored content.",
    "- Reject third-party personal profile facts, even if they mention a name.",
    "- Reject vague content such as 'remember this' unless the candidate or current-user-message contains the concrete fact.",
    "- Preserve the requested expiration when one exists; otherwise set expiresAtMs to null.",
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
    memoryKindsContext(),
    "",
    sessionMessagesContext(request),
    "",
    "<rules>",
    "- Return at most five memories.",
    "- Use user role messages as the only source of storable facts.",
    "- Use assistant role messages only to reject confirmations, follow-up questions, or memory-management turns.",
    "- Return one memory per distinct fact.",
    "- Ignore advice, how-to, search, recall, planning, list, inspect, and remove requests unless user messages also state a durable fact.",
    "- Fill procedures with reusable task/process/runbook instructions.",
    "- Fill facts with shared team, project, channel, runbook, or operational knowledge.",
    "- Fill preferences only with clear durable facts about the current requester as a person/user, such as their own preference, opinion, habit, identity, or workflow.",
    "- User-authored task instructions are procedures, not preferences, unless they explicitly describe the requester's personal preference or habit.",
    "- Procedural statements such as 'for X, do Y', 'when X, do Y', and 'to accomplish X, do Y' belong in procedures.",
    ...CANONICAL_CONTENT_RULES,
    "- Skip a candidate when existing-memories already cover the same durable fact.",
    "- Reject third-party personal profile facts, even if they mention a name.",
    "- If unsure, return no memory for that candidate.",
    "</rules>",
    "</memory-extraction-input>",
  ].join("\n");
}

/** Create the memory-owned agent that reviews and extracts memory candidates. */
export function createMemoryAgent(model: PluginModel): MemoryAgent {
  return {
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
      target: targetForKind(response.kind),
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
    target: MemoryTarget,
    memory: z.output<typeof extractedMemorySchema>,
  ): ExtractedMemory => ({
    content: memory.canonicalFact,
    expiresAtMs: memory.expiresAtMs,
    target,
  });
  return [
    ...response.procedures.map((memory) => toMemory("conversation", memory)),
    ...response.facts.map((memory) => toMemory("conversation", memory)),
    ...response.preferences.map((memory) => toMemory("requester", memory)),
  ];
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
