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
    content: z
      .string()
      .min(1)
      .nullable()
      .describe(
        "Canonical perspective-neutral fact when decision is store, otherwise null. Do not include requester names, display names, 'the requester', 'the user', 'I', 'my', 'this thread', or channel/source labels. Good: 'Prefers terse PR summaries'. Good: 'Favorite CLI QA snack is mango chips'. Good: 'Deploy runbooks live in Notion'. Bad: 'The requester prefers terse PR summaries'. Bad: 'David prefers terse PR summaries'. Bad: 'This thread says deploy runbooks live in Notion'.",
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

type MemoryReviewResponse = z.output<typeof memoryReviewResponseSchema>;

export type MemoryTarget = z.output<typeof memoryTargetSchema>;

export type MemoryReview = z.output<typeof memoryReviewDecisionSchema>;

export type CreateMemoryRequest = z.output<typeof createMemoryRequestSchema>;

export interface MemoryAgent {
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
  "Return every response field. Use null for fields that do not apply to the decision.",
].join("\n");

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function runtimeDescription(request: CreateMemoryRequest): string {
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
    "- Remove phrases such as 'I', 'my', 'the requester', 'the user', user names, 'this thread', 'this channel', and Slack/source labels from stored content.",
    "- Good stored content: 'Prefers terse PR summaries'. Bad stored content: 'The requester prefers terse PR summaries'.",
    "- Good stored content: 'Favorite CLI QA snack is mango chips'. Bad stored content: 'My favorite CLI QA snack is mango chips'.",
    "- Good stored content: 'Thinks types in Python are bad'. Bad stored content: 'David thinks types in Python are bad'.",
    "- Good stored content: 'Deploy runbooks live in Notion'. Bad stored content: 'This thread says deploy runbooks live in Notion'.",
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

/** Create the memory-owned agent that reviews candidates before storage. */
export function createMemoryAgent(model: PluginModel): MemoryAgent {
  return {
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
      content: response.content,
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
