import * as z from "zod";
import type { AttachmentStorage } from "@/chat/attachments/storage";
import { publishImage } from "@/chat/artifacts/store";
import { getChatConfig } from "@/chat/config";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import {
  normalizeSandboxPath,
  SandboxFileNotFoundError,
} from "@/chat/sandbox/file-uploads";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import type { JuniorSqlDatabase } from "@/db/db";
import { IMAGES_TOOL_SOURCE } from "@/chat/artifacts/tool-source";

const outputSchema = juniorToolOutputSchema.extend({
  bytes: z.number().int().positive(),
  content_type: z.string().min(1),
  /** Present when the URL expires. */
  expires_at: z.string().datetime().optional(),
  public: z.literal(true),
  url: z.string().url(),
});

/**
 * Create a tool that publishes one sandbox image at a public internet URL.
 *
 * @runBuilt publishImage
 */
export function createPublishImageTool(args: {
  conversationId: string;
  db: JuniorSqlDatabase;
  storage: Pick<AttachmentStorage, "put">;
  workspace: SandboxWorkspace;
}) {
  return zodTool({
    exposure: "deferred",
    source: IMAGES_TOOL_SOURCE,
    annotations: {
      destructiveHint: false,
      // An expiring publish makes a new URL each call.
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: false,
    },
    approvalMode: "approve",
    description:
      "Publish one sandbox image to a public HTTPS URL. Anyone on the internet with the URL can view the image until it expires or is unpublished. Use only when an external destination needs a public image URL. Do not use for private file sharing or private conversation storage. Supports PNG, JPEG, GIF, and WebP up to 10 MB.",
    executionMode: "sequential",
    inputSchema: z
      .object({
        path: z
          .string()
          .min(1)
          .describe("Exact sandbox path of an existing image file."),
        expires_in_minutes: z
          .number()
          .int()
          .min(1)
          .max(7 * 24 * 60)
          .optional()
          .describe(
            "Minutes until the URL stops serving. Set it when the destination needs the image only briefly, such as a service that fetches it once. Omit for a URL that serves until unpublished.",
          ),
      })
      .strict(),
    outputSchema,
    async execute({ path, expires_in_minutes }) {
      const publicBaseUrl = getChatConfig().deployment.baseUrl;
      if (!publicBaseUrl) {
        throw new Error(
          "publishImage requires JUNIOR_BASE_URL or a Vercel deployment URL.",
        );
      }

      const targetPath = normalizeSandboxPath(path);
      const body = await args.workspace.readFileToBuffer({ path: targetPath });
      if (!body) {
        throw new SandboxFileNotFoundError(targetPath);
      }

      // Validation failures throw ToolInputError. Storage, SQL, and host-config
      // failures stay system errors so they reach Sentry.
      const image = await publishImage({
        body,
        conversationId: args.conversationId,
        db: args.db,
        ...(expires_in_minutes === undefined
          ? undefined
          : { expiresAt: new Date(Date.now() + expires_in_minutes * 60_000) }),
        publicBaseUrl,
        storage: args.storage,
      });
      return {
        bytes: image.bytes,
        content_type: image.contentType,
        ...(image.expiresAt
          ? { expires_at: image.expiresAt.toISOString() }
          : undefined),
        public: true as const,
        url: image.url,
      };
    },
  });
}
