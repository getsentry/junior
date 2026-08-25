/** Validate the ACP wire messages that Junior supports. */
import * as acp from "@agentclientprotocol/sdk";
import { z } from "zod";

const ACP_SESSION_ID_PATTERN = /^local:acp:[a-f0-9]{32}$/;
const metaSchema = z.record(z.string(), z.unknown()).nullable();
const jsonRpcIdSchema = z.union([z.string(), z.number().finite(), z.null()]);

export const SESSION_HEADER_METHODS = new Set<string>([
  acp.methods.agent.session.cancel,
  acp.methods.agent.session.close,
  acp.methods.agent.session.load,
  acp.methods.agent.session.prompt,
  acp.methods.agent.session.resume,
  acp.methods.agent.session.setConfigOption,
  acp.methods.agent.session.setMode,
]);

export const acpConnectionIdSchema = z.string().uuid();
export const acpSessionIdSchema = z.string().regex(ACP_SESSION_ID_PATTERN);

export const acpCallSchema = z
  .object({
    id: jsonRpcIdSchema.optional(),
    jsonrpc: z.literal("2.0"),
    method: z.string().min(1),
    params: z.unknown().optional(),
  })
  .strict();

const jsonRpcErrorSchema = z
  .object({
    code: z.number().int(),
    data: z.unknown().optional(),
    message: z.string(),
  })
  .strict();

export const acpResponseSchema = z.union([
  z
    .object({
      id: jsonRpcIdSchema,
      jsonrpc: z.literal("2.0"),
      result: z.unknown(),
    })
    .strict(),
  z
    .object({
      error: jsonRpcErrorSchema,
      id: jsonRpcIdSchema,
      jsonrpc: z.literal("2.0"),
    })
    .strict(),
]);

export const acpInboundMessageSchema = z.union([
  acpCallSchema,
  acpResponseSchema,
]);

const implementationSchema = z
  .object({
    _meta: metaSchema.optional(),
    name: z.string().min(1),
    title: z.string().nullable().optional(),
    version: z.string(),
  })
  .strict();

export const initializeParamsSchema = z
  .object({
    _meta: metaSchema.optional(),
    clientCapabilities: z.record(z.string(), z.unknown()).optional(),
    clientInfo: implementationSchema.nullable().optional(),
    protocolVersion: z.number().int().min(0).max(65_535),
  })
  .strict();

export const authenticateParamsSchema = z
  .object({
    _meta: metaSchema.optional(),
    methodId: z.string().min(1),
  })
  .strict();

export const newSessionParamsSchema = z
  .object({
    _meta: metaSchema.optional(),
    additionalDirectories: z.array(z.string()).optional(),
    cwd: z.string().min(1),
    mcpServers: z.array(z.unknown()),
  })
  .strict();

export const loadSessionParamsSchema = newSessionParamsSchema.extend({
  sessionId: acpSessionIdSchema,
});

const annotationsSchema = z
  .object({
    _meta: metaSchema.optional(),
    audience: z
      .array(z.enum(["assistant", "user"]))
      .nullable()
      .optional(),
    lastModified: z.string().nullable().optional(),
    priority: z.number().finite().nullable().optional(),
  })
  .strict();

const textContentBlockSchema = z
  .object({
    _meta: metaSchema.optional(),
    annotations: annotationsSchema.nullable().optional(),
    text: z.string(),
    type: z.literal("text"),
  })
  .strict();

export const promptParamsSchema = z
  .object({
    _meta: metaSchema.optional(),
    prompt: z.array(textContentBlockSchema),
    sessionId: acpSessionIdSchema,
  })
  .strict();

export const cancelParamsSchema = z
  .object({
    _meta: metaSchema.optional(),
    sessionId: acpSessionIdSchema,
  })
  .strict();

export type AcpCall = z.output<typeof acpCallSchema>;
export type AcpResponse = z.output<typeof acpResponseSchema>;
export type SessionParams = z.output<typeof newSessionParamsSchema>;
export type LoadSessionParams = z.output<typeof loadSessionParamsSchema>;
export type PromptParams = z.output<typeof promptParamsSchema>;
export type CancelParams = z.output<typeof cancelParamsSchema>;
