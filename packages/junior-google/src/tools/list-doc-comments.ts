import {
  definePluginTool,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import {
  docReferenceSchema,
  driveFileRequest,
  parseDocReference,
} from "./docs";
import type { GoogleToolContext } from "./shared";

const inputSchema = z
  .object({
    document: docReferenceSchema,
    pageToken: z
      .string()
      .min(1)
      .max(2048)
      .optional()
      .describe("nextPageToken from an earlier call, to read more comments."),
  })
  .strict();

const replyOutputSchema = z.object({
  action: z
    .enum(["resolve", "reopen"])
    .optional()
    .describe("Set when the reply resolved or reopened the comment."),
  author: z.string().optional(),
  content: z.string(),
  createdTime: z.string().optional(),
});

const commentOutputSchema = z.object({
  author: z.string().optional(),
  commentId: z.string(),
  content: z.string(),
  createdTime: z.string().optional(),
  quotedText: z
    .string()
    .optional()
    .describe("The Doc text that the comment is attached to."),
  replies: z.array(replyOutputSchema),
  resolved: z.boolean(),
});

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("listGoogleDocComments"),
  comments: z.array(commentOutputSchema),
  documentId: z.string(),
  nextPageToken: z
    .string()
    .optional()
    .describe("Set when the Doc has more comments. Pass it as pageToken."),
});

const authorSchema = z
  .object({ displayName: z.string().optional() })
  .optional();

const commentListSchema = z.object({
  comments: z
    .array(
      z.object({
        author: authorSchema,
        content: z.string().default(""),
        createdTime: z.string().optional(),
        id: z.string(),
        quotedFileContent: z
          .object({ value: z.string().optional() })
          .optional(),
        replies: z
          .array(
            z.object({
              // Google may add actions; keep only the known ones.
              action: z.enum(["resolve", "reopen"]).optional().catch(undefined),
              author: authorSchema,
              content: z.string().default(""),
              createdTime: z.string().optional(),
            }),
          )
          .default([]),
        resolved: z.boolean().optional(),
      }),
    )
    .default([]),
  nextPageToken: z.string().optional(),
});

const COMMENT_FIELDS =
  "comments(author/displayName,content,createdTime,id,quotedFileContent/value,resolved,replies(action,author/displayName,content,createdTime)),nextPageToken";

/** List the comments and replies on one Google Doc. */
export function createListGoogleDocCommentsTool(ctx: GoogleToolContext) {
  return definePluginTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },
    description:
      "List the comments and replies on one Google Doc, as Junior's own Google account sees them. Each comment gives its author, text, the Doc text it is attached to, and whether it is resolved. Works for Docs shared with that account and Docs shared with anyone who has the link. Returns up to 100 comments per call; pass nextPageToken as pageToken to read more. Comments can be private: share only what the requester needs.",
    inputSchema,
    outputSchema,
    async execute(input) {
      const doc = parseDocReference(input.document);
      const response = await driveFileRequest(ctx, doc, {
        operation: "google.drive.comments.list",
        path: `/drive/v3/files/${doc.fileId}/comments`,
        query: {
          fields: COMMENT_FIELDS,
          pageSize: "100",
          ...(input.pageToken ? { pageToken: input.pageToken } : undefined),
        },
      });
      const { comments, nextPageToken } = commentListSchema.parse(
        response.body,
      );
      return {
        target: "listGoogleDocComments" as const,
        comments: comments.map((comment) => ({
          ...(comment.author?.displayName
            ? { author: comment.author.displayName }
            : undefined),
          commentId: comment.id,
          content: comment.content,
          ...(comment.createdTime
            ? { createdTime: comment.createdTime }
            : undefined),
          ...(comment.quotedFileContent?.value
            ? { quotedText: comment.quotedFileContent.value }
            : undefined),
          replies: comment.replies.map((reply) => ({
            ...(reply.action ? { action: reply.action } : undefined),
            ...(reply.author?.displayName
              ? { author: reply.author.displayName }
              : undefined),
            content: reply.content,
            ...(reply.createdTime
              ? { createdTime: reply.createdTime }
              : undefined),
          })),
          resolved: comment.resolved === true,
        })),
        documentId: doc.fileId,
        ...(nextPageToken ? { nextPageToken } : undefined),
      };
    },
  });
}
