import {
  definePluginTool,
  type PluginToolContent,
  type PluginToolExecuteOptions,
  type PluginToolResult,
  type PluginToolResultEnvelope,
  type ToolRegistrationHookContext,
  pluginToolResultSchema,
} from "@sentry/junior-plugin-api";
import { z } from "zod";

const nullableName = (description: string) =>
  z.string().trim().min(1).nullable().describe(description).optional();

const inputSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .describe("Linear issue identifier or ID to update."),
    assignee: nullableName(
      'Assignee name, email, identifier, or "me". Use null to clear.',
    ),
    cycle: nullableName("Cycle name or identifier. Use null to clear."),
    description: z
      .string()
      .nullable()
      .describe("Issue description. Use null to clear.")
      .optional(),
    estimate: z
      .number()
      .nonnegative()
      .nullable()
      .describe("Issue estimate. Use null to clear.")
      .optional(),
    labels: z
      .array(z.string().trim().min(1))
      .describe("Complete set of issue label names or identifiers.")
      .optional(),
    priority: z
      .enum(["low", "medium", "high", "urgent"])
      .nullable()
      .describe("Linear priority. Use null to clear.")
      .optional(),
    project: nullableName("Project name or identifier. Use null to clear."),
    state: z
      .string()
      .trim()
      .min(1)
      .describe("Workflow state name or identifier.")
      .optional(),
    team: z
      .string()
      .trim()
      .min(1)
      .describe("Team name or identifier.")
      .optional(),
    title: z.string().trim().min(1).max(60).describe("Issue title.").optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (Object.keys(input).every((key) => key === "id")) {
      ctx.addIssue({
        code: "custom",
        message: "At least one issue field must be provided.",
      });
    }
  });

type UpdateLinearIssueInput = z.output<typeof inputSchema>;

const outputSchema = pluginToolResultSchema.extend({
  ok: z.literal(true),
  status: z.literal("success"),
  target: z.literal("updateIssue"),
});

interface UpdateLinearIssueResult extends PluginToolResult {
  ok: true;
  status: "success";
  target: "updateIssue";
}

function toolResult(
  content: PluginToolContent[],
): PluginToolResultEnvelope<UpdateLinearIssueResult> {
  return {
    content,
    details: {
      ok: true,
      status: "success",
      target: "updateIssue",
    },
  };
}

function authorizationPendingResult(): PluginToolResultEnvelope<UpdateLinearIssueResult> {
  return toolResult([{ type: "text", text: "Authorization pending." }]);
}

/** Update a Linear issue through the hosted MCP provider. */
export function createLinearUpdateIssueTool(ctx: ToolRegistrationHookContext) {
  return definePluginTool({
    description:
      "Update an existing Linear issue through Linear's hosted MCP provider. Fetch the issue first when a change could overwrite existing fields.",
    inputSchema,
    outputSchema,
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
      title: "Update Linear issue",
    },
    describeProposal(input) {
      return `Update Linear issue ${input.id}`;
    },
    async execute(
      input: UpdateLinearIssueInput,
      options: PluginToolExecuteOptions,
    ) {
      const mcp = ctx.mcp;
      if (!mcp) {
        throw new Error("Linear MCP provider is unavailable.");
      }
      if ((await mcp.prepare()) === "authorization_pending") {
        return authorizationPendingResult();
      }

      const result = await mcp.callTool({
        name: "save_issue",
        arguments: input,
        toolCallId: options.toolCallId,
      });
      if (result.status === "authorization_pending") {
        return authorizationPendingResult();
      }
      if (result.status === "error") {
        throw new Error(result.message);
      }
      return toolResult(result.content);
    },
  });
}
