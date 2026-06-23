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
const extractTurnRequestSchema = z
  .object({
    assistantText: z.string(),
    runtimeContext: memoryRuntimeContextSchema,
    userText: z.string().min(1),
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
        "Canonical perspective-neutral fact when decision is store, otherwise null. For requester memories, omit the subject and write a stable fact such as 'Prefers X', 'Uses Y', or 'Thinks Z'. Do not include requester names, display names, 'the requester', 'the user', first-person wording like 'I', 'me', 'my', 'mine', 'we', or 'our', second-person wording like 'you' or 'your', 'this thread', or channel/source labels. Good: 'Prefers morning standup notes'. Good: 'Favorite editor theme is Solarized Light'. Good: 'Release checklist lives in Linear'. Bad: 'I prefer morning standup notes'. Bad: 'The requester prefers morning standup notes'. Bad: 'David prefers morning standup notes'. Bad: 'This thread says the release checklist lives in Linear'.",
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
const extractedMemorySchema = z
  .object({
    target: memoryTargetSchema.describe(
      "Where the memory should be stored when this is accepted.",
    ),
    canonicalFact: z
      .string()
      .min(1)
      .describe(
        "Canonical perspective-neutral fact. For requester memories, omit the subject and write a stable fact such as 'Prefers X', 'Uses Y', or 'Thinks Z'. Do not include requester names, display names, 'the requester', 'the user', first-person wording like 'I', 'me', 'my', 'mine', 'we', or 'our', second-person wording like 'you' or 'your', 'this thread', or channel/source labels.",
      ),
    expiresAtMs: z
      .number()
      .finite()
      .nullable()
      .describe(
        "Expiration timestamp when the fact should expire, otherwise null.",
      ),
  })
  .strict();
const extractTurnResponseSchema = z
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
type ExtractTurnResponse = z.output<typeof extractTurnResponseSchema>;

export type MemoryTarget = z.output<typeof memoryTargetSchema>;

export type MemoryReview = z.output<typeof memoryReviewDecisionSchema>;

export type CreateMemoryRequest = z.output<typeof createMemoryRequestSchema>;
export type ExtractTurnRequest = z.output<typeof extractTurnRequestSchema>;
export interface ExtractedMemory {
  content: string;
  expiresAtMs: number | null;
  target: MemoryTarget;
}

export interface MemoryAgent {
  extractTurnMemories(
    request: ExtractTurnRequest,
  ): Promise<ExtractedMemory[]> | ExtractedMemory[];
  reviewCreateRequest(
    request: CreateMemoryRequest,
  ): Promise<MemoryReview> | MemoryReview;
}

const MEMORY_REVIEW_SYSTEM = [
  "You are Junior's memory review agent.",
  "Review one explicit createMemory candidate and return one structured review decision.",
  "Store only public/shareable, self-contained facts that are useful beyond this turn.",
  "Reject secrets, credentials, private/sensitive personal details, gossip, speculative coworker claims, assistant/system implementation details, vague references, and low-durability chatter.",
  "Personal/requester memories must be authored by the current requester as first-person facts about themselves, then stored as perspective-neutral canonical facts without names or requester/source wording.",
  "The current user-authored text is source evidence. If it states a first-person fact about the requester, do not reject merely because the candidate rewrites it with the requester's name, 'the requester', or third-person wording.",
  "Conversation memories must be shared operational or project knowledge about the active conversation, not another person's private profile.",
  "Do not accept model/caller-provided actor ids, scope ids, aliases, or arbitrary subjects.",
  "For accepted memories, rewrite content into one concise declarative fact that is understandable without the original conversation and does not bake in who said it or where it was said.",
  "For requester memories, omit the subject and use canonical phrasing such as 'Prefers X', 'Uses Y', or 'Thinks Z'; never output 'I', 'me', 'my', 'mine', 'we', 'our', 'you', 'your', a requester name, 'the requester', or 'the user'.",
  "Before returning store, self-check the content: if it could be read as the user's direct quote, rewrite it into omitted-subject canonical prose.",
  "Return every response field. Use null for fields that do not apply to the decision.",
].join("\n");
const MEMORY_EXTRACTION_SYSTEM = [
  "You are Junior's passive memory extraction agent.",
  "Review one completed user-authored turn and return structured memories that should be stored.",
  "Store only public/shareable, durable, self-contained facts useful beyond this turn.",
  "Do not store secrets, credentials, private/sensitive personal details, gossip, speculative coworker claims, assistant/system implementation details, vague references, or low-durability chatter.",
  "Personal/requester memories must come from the user's own first-person statements about themselves, then be stored as perspective-neutral canonical facts without names or requester/source wording.",
  "Conversation memories must be shared operational or project knowledge about the active conversation, not another person's private profile.",
  "Extract only facts explicitly present in the user-authored message. Assistant text is rejection context only; never use assistant text, tool results, recalled memory text, or suggested wording as source evidence.",
  "Never store a fact merely because the assistant suggested or invented it. The user-authored text is the source of truth.",
  "For requester memories, omit the subject and use canonical phrasing such as 'Prefers X', 'Uses Y', or 'Thinks Z'; never output 'I', 'me', 'my', 'mine', 'we', 'our', 'you', 'your', a requester name, 'the requester', or 'the user'.",
  "Before returning a requester memory, self-check the content: if it could be read as the user's direct quote, rewrite it into omitted-subject canonical prose.",
  "Return one memory per distinct fact. If a first-person requester fact mentions a workstream, project, or conversation topic, keep that context inside the requester memory instead of also creating a conversation memory for the same fact.",
  "Advice, how-to, search, recall, and planning questions are not memories by themselves. Extract from those turns only when the user states a durable self-fact or shared project fact that remains true beyond the request.",
  "Do not duplicate explicit memory tool outcomes; turns that used memory tools are filtered before this agent, but if the user text is asking to list, search, recall, remove, confirm, or inspect existing memories, return no memories.",
  "Return only accepted memories. If there are no accepted memories, return an empty memories array.",
].join("\n");

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
    "- A candidate may be badly phrased by the outer assistant. When current-user-message contains the requester's own first-person memory request, treat that as requester-authored source evidence and canonicalize the fact instead of rejecting for third-person wording.",
    "- Use target=conversation only for shared operational/project knowledge in the active conversation.",
    "- Store content as person-less, source-less canonical knowledge. Ownership and source live in structured metadata, not prose.",
    "- For requester memories, omit the subject and write the content as a stable fact such as 'Prefers X', 'Uses Y', or 'Thinks Z'.",
    "- If the stored content would still sound like the user's direct quote, rewrite it before returning store.",
    "- Remove phrases such as 'I', 'me', 'my', 'mine', 'we', 'our', 'you', 'your', 'the requester', 'the user', user names, 'this thread', 'this channel', and Slack/source labels from stored content.",
    "- Good stored content: 'Prefers morning standup notes'. Bad stored content: 'The requester prefers morning standup notes'.",
    "- Good stored content: 'Favorite editor theme is Solarized Light'. Bad stored content: 'My favorite editor theme is Solarized Light'.",
    "- Good stored content: 'Thinks runtime logs should include request ids'. Bad stored content: 'David thinks runtime logs should include request ids'.",
    "- Good stored content: 'Release checklist lives in Linear'. Bad stored content: 'This thread says the release checklist lives in Linear'.",
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

function extractionPrompt(request: ExtractTurnRequest): string {
  return [
    "<memory-extraction-input>",
    "Extract durable memories from this completed user-authored turn using the runtime-owned context below.",
    "",
    runtimeDescription({
      runtimeContext: request.runtimeContext,
    }),
    "",
    "<user-message>",
    escapeXml(request.userText),
    "</user-message>",
    "",
    "<assistant-response>",
    escapeXml(request.assistantText),
    "</assistant-response>",
    "",
    "<rules>",
    "- Return at most five memories.",
    "- The user-message is the only source of storable facts.",
    "- Use assistant-response only to identify non-memory turns, confirmations, or follow-up questions. Do not store facts from assistant-response.",
    "- Return one memory per distinct fact. Do not store the same fact under both requester and conversation targets.",
    "- Do not store advice, how-to, search, recall, or planning requests unless the user-message also states a durable fact independent of the request.",
    "- Return an empty array when the user-message only asks what is remembered, how to use a remembered preference, or asks to list/search/remove/inspect memory.",
    "- Use target=requester for first-person facts about the current requester.",
    "- Use target=conversation only for shared operational/project knowledge.",
    "- Store content as person-less, source-less canonical knowledge. Ownership and source live in structured metadata, not prose.",
    "- For requester memories, omit the subject and write the content as a stable fact such as 'Prefers X', 'Uses Y', or 'Thinks Z'.",
    "- If the stored content would still sound like the user's direct quote, rewrite it before returning it.",
    "- Good stored content: 'Prefers morning standup notes'. Bad stored content: 'The requester prefers morning standup notes'.",
    "- Good stored content: 'Thinks runtime logs should include request ids'. Bad stored content: 'David thinks runtime logs should include request ids'.",
    "- Good stored content: 'Release checklist lives in Linear'. Bad stored content: 'This thread says the release checklist lives in Linear'.",
    "- Reject third-party personal profile facts, even if they mention a name.",
    "- Reject facts that are only useful inside this one turn.",
    "- If unsure, return no memory for that candidate.",
    "</rules>",
    "</memory-extraction-input>",
  ].join("\n");
}

/** Create the memory-owned agent that reviews candidates before storage. */
export function createMemoryAgent(model: PluginModel): MemoryAgent {
  return {
    async extractTurnMemories(rawRequest) {
      const request = extractTurnRequestSchema.parse(rawRequest);
      const result = await model.completeObject({
        schema: extractTurnResponseSchema,
        system: MEMORY_EXTRACTION_SYSTEM,
        prompt: extractionPrompt(request),
        maxTokens: 1_000,
      });
      return extractedMemoriesFromResponse(
        extractTurnResponseSchema.parse(result.object),
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
  response: ExtractTurnResponse,
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
