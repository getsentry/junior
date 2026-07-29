import {
  definePluginTool,
  PluginToolInputError,
  pluginToolContentSchema,
  type PluginMcpToolSuccess,
  type PluginToolContent,
  type PluginToolExecuteOptions,
  type PluginToolResult,
  type PluginToolResultEnvelope,
  type ToolRegistrationHookContext,
  pluginToolResultSchema,
} from "@sentry/junior-plugin-api";
import { z } from "zod";

const CREATE_ISSUE_STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CREATE_ISSUE_LOCK_TTL_MS = 60_000;

const inputSchema = z
  .object({
    team: z.string().trim().min(1).describe("Linear team name or identifier."),
    title: z.string().trim().min(1).max(60).describe("Issue title."),
    description: z.string().describe("Issue description.").optional(),
    priority: z
      .enum(["low", "medium", "high", "urgent"])
      .describe("Linear priority.")
      .optional(),
    project: z
      .string()
      .trim()
      .min(1)
      .describe("Linear project name or identifier.")
      .optional(),
  })
  .strict();

type CreateLinearIssueInput = z.output<typeof inputSchema>;

const issueSchema = z
  .object({
    id: z.string().optional(),
    identifier: z.string().optional(),
    title: z.string().optional(),
    url: z.string().url().optional(),
  })
  .strict();

type LinearIssue = z.output<typeof issueSchema>;

const outputSchema = pluginToolResultSchema.extend({
  ok: z.literal(true),
  status: z.literal("success"),
  target: z.literal("createIssue"),
  data: z.object({
    issue: issueSchema.nullable(),
  }),
  issue: issueSchema.nullable(),
});

const completedStateSchema = z
  .object({
    createdAtMs: z.number(),
    content: z.array(pluginToolContentSchema),
    issue: issueSchema.nullable(),
    status: z.literal("completed"),
  })
  .strict();

const pendingStateSchema = z
  .object({
    createdAtMs: z.number(),
    status: z.literal("pending"),
  })
  .strict();

const stateSchema = z.union([completedStateSchema, pendingStateSchema]);
type CreateIssueState = z.output<typeof stateSchema>;

interface LinearIssueToolResult extends PluginToolResult {
  data: {
    issue: LinearIssue | null;
  };
  issue: LinearIssue | null;
  ok: true;
  status: "success";
  target: "createIssue";
}

function parseState(value: unknown): CreateIssueState | undefined {
  const parsed = stateSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function collectObjects(
  value: unknown,
  objects: Record<string, unknown>[],
): void {
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectObjects(item, objects);
    return;
  }
  const record = value as Record<string, unknown>;
  objects.push(record);
  for (const item of Object.values(record)) collectObjects(item, objects);
}

function stringField(
  objects: Record<string, unknown>[],
  field: string,
): string | undefined {
  for (const object of objects) {
    const value = object[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extractIssue(result: PluginMcpToolSuccess): LinearIssue | null {
  const objects: Record<string, unknown>[] = [];
  collectObjects(result.structuredContent, objects);
  const textParts = result.content.flatMap((part) =>
    part.type === "text" ? [part.text] : [],
  );
  for (const text of textParts) {
    collectObjects(parseJsonText(text), objects);
  }

  const urlMatch = textParts
    .map((text) =>
      text.match(
        /https:\/\/linear\.app\/[^\s<>)"']+\/issue\/([A-Z][A-Z0-9]*-\d+)[^\s<>)"']*/i,
      ),
    )
    .find((match) => match !== null);
  const identifierMatch = textParts
    .map((text) => text.match(/\b[A-Z][A-Z0-9]*-\d+\b/))
    .find((match) => match !== null);
  const issue = {
    id: stringField(objects, "id"),
    identifier:
      stringField(objects, "identifier") ??
      urlMatch?.[1]?.toUpperCase() ??
      identifierMatch?.[0],
    title: stringField(objects, "title"),
    url: stringField(objects, "url") ?? urlMatch?.[0],
  };
  const parsed = issueSchema.safeParse(
    Object.fromEntries(
      Object.entries(issue).filter((entry) => entry[1] !== undefined),
    ),
  );
  if (!parsed.success || Object.keys(parsed.data).length === 0) {
    return null;
  }
  return parsed.data;
}

function toolResult(
  issue: LinearIssue | null,
  content: PluginToolContent[],
): PluginToolResultEnvelope<LinearIssueToolResult> {
  const data = { issue };
  return {
    content,
    details: {
      ok: true,
      status: "success",
      target: "createIssue",
      data,
      ...data,
    },
  };
}

function authorizationPendingResult(): PluginToolResultEnvelope<LinearIssueToolResult> {
  return toolResult(null, [{ type: "text", text: "Authorization pending." }]);
}

async function annotateIssue(
  ctx: ToolRegistrationHookContext,
  issue: LinearIssue | null,
): Promise<void> {
  if (!issue?.identifier || !issue.url) {
    return;
  }
  await ctx.annotations?.upsert({
    kind: "resource_link",
    key: issue.identifier.toUpperCase(),
    label: issue.identifier.toUpperCase(),
    url: issue.url,
    status: "open",
  });
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new PluginToolInputError(`${name} is required`);
  return value.trim();
}

/** Create a Linear issue through the hosted MCP provider and link it to the conversation. */
export function createLinearIssueTool(ctx: ToolRegistrationHookContext) {
  return definePluginTool({
    description:
      "Create a Linear issue through Linear's hosted MCP provider and link the created issue to the current Junior conversation.",
    inputSchema,
    outputSchema,
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
      title: "Create Linear issue",
    },
    describeProposal(input) {
      return `Create a Linear issue in ${input.team}: ${input.title}`;
    },
    async execute(
      input: CreateLinearIssueInput,
      options: PluginToolExecuteOptions,
    ) {
      const mcp = ctx.mcp;
      if (!mcp) {
        throw new Error("Linear MCP provider is unavailable.");
      }
      const conversationId = required(ctx.conversationId, "conversationId");
      const toolCallId = required(options.toolCallId, "toolCallId");
      if ((await mcp.prepare()) === "authorization_pending") {
        return authorizationPendingResult();
      }

      const key = `createIssue:${conversationId}:${toolCallId}`;
      return await ctx.state.withLock(
        `${key}:lock`,
        CREATE_ISSUE_LOCK_TTL_MS,
        async () => {
          const state = parseState(await ctx.state.get(key));
          if (state?.status === "completed") {
            await annotateIssue(ctx, state.issue);
            return toolResult(state.issue, state.content);
          }
          if (state?.status === "pending") {
            throw new Error(
              "Linear issue creation for this tool call has an uncertain pending result; refusing to create a duplicate issue.",
            );
          }

          await ctx.state.set(
            key,
            { status: "pending", createdAtMs: Date.now() },
            CREATE_ISSUE_STATE_TTL_MS,
          );
          const result = await mcp.callTool({
            name: "save_issue",
            arguments: input,
            toolCallId,
          });
          if (result.status === "authorization_pending") {
            await ctx.state.delete(key);
            return authorizationPendingResult();
          }
          if (result.status === "error") {
            await ctx.state.delete(key);
            throw new Error(result.message);
          }
          const issue = extractIssue(result);
          const completedState: CreateIssueState = {
            status: "completed",
            createdAtMs: Date.now(),
            content: result.content,
            issue,
          };
          try {
            await ctx.state.set(key, completedState, CREATE_ISSUE_STATE_TTL_MS);
          } catch (error) {
            throw new Error(
              "Linear issue was created, but Junior could not persist the completed issue state.",
              { cause: error },
            );
          }
          await annotateIssue(ctx, issue);
          return toolResult(issue, result.content);
        },
      );
    },
  });
}
