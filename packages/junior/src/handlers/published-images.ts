import { createVercelAttachmentStorage } from "@/chat/attachments/vercel";
import type { AttachmentStorage } from "@/chat/attachments/storage";
import {
  publishedImageHeaders,
  readPublishedImage,
} from "@/chat/published-images/store";
import { logException } from "@/chat/logging";

/** Serve one content-addressed image without authentication. */
export async function publishedImageGET(args: {
  filename: string;
  storage?: Pick<AttachmentStorage, "get">;
}): Promise<Response> {
  try {
    const image = await readPublishedImage({
      filename: args.filename,
      storage: args.storage ?? createVercelAttachmentStorage(),
    });
    if (!image) return new Response("Not Found", { status: 404 });

    return new Response(image.body, {
      headers: publishedImageHeaders(image.contentType),
    });
  } catch (error) {
    logException(error, "published_image.get.failed");
    return new Response("Internal Server Error", { status: 500 });
  }
}
