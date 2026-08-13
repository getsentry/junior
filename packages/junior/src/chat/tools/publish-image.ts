import { z } from "zod";
import type { AttachmentStorage } from "@/chat/attachments/storage";
import { resolveBaseUrl } from "@/chat/oauth-flow";
import { publishImage } from "@/chat/published-images/store";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import {
  normalizeSandboxPath,
  SandboxFileNotFoundError,
} from "@/chat/tools/sandbox/file-uploads";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";

const outputSchema = juniorToolOutputSchema.extend({
  bytes: z.number().int().positive(),
  content_type: z.string().min(1),
  public: z.literal(true),
  url: z.string().url(),
});

/** Create a tool that publishes one sandbox image at a public internet URL. */
export function createPublishImageTool(args: {
  publicBaseUrl?: () => string | undefined;
  storage: Pick<AttachmentStorage, "put">;
  workspace: SandboxWorkspace;
}) {
  return zodTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    },
    approvalMode: "review",
    description:
      "Publish one sandbox image to a durable public HTTPS URL. Anyone on the internet with the URL can view the image. Use only when an external destination needs a public image URL. Do not use for private file sharing or private conversation storage. Supports PNG, JPEG, GIF, and WebP up to 10 MB.",
    describeProposal: ({ path }) =>
      `Publish sandbox image ${path} to a public internet URL.`,
    executionMode: "sequential",
    inputSchema: z
      .object({
        path: z
          .string()
          .min(1)
          .describe("Exact sandbox path of an existing image file."),
      })
      .strict(),
    outputSchema,
    async execute({ path }) {
      const publicBaseUrl = (args.publicBaseUrl ?? resolveBaseUrl)()?.trim();
      if (!publicBaseUrl) {
        throw new ToolInputError(
          "publishImage requires JUNIOR_BASE_URL or a Vercel deployment URL.",
        );
      }

      const targetPath = normalizeSandboxPath(path);
      const body = await args.workspace.readFileToBuffer({ path: targetPath });
      if (!body) {
        throw new SandboxFileNotFoundError(targetPath);
      }

      let image;
      try {
        image = await publishImage({
          body,
          publicBaseUrl,
          storage: args.storage,
        });
      } catch (error) {
        throw new ToolInputError(
          error instanceof Error ? error.message : "failed to publish image",
        );
      }
      return {
        bytes: image.bytes,
        content_type: image.contentType,
        public: true as const,
        url: image.url,
      };
    },
  });
}
