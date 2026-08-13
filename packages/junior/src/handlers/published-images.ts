import {
  publishedImageHeaders,
  readPublishedImage,
} from "@/chat/published-images/store";
import type { PublishedImageStorage } from "@/chat/published-images/storage";
import { createVercelAttachmentStorage } from "@/chat/attachments/vercel";
import { logException } from "@/chat/logging";

/** Serve one content-addressed published image without authentication. */
export async function publishedImageGET(
  request: Request,
  options: {
    extension: string;
    sha256: string;
    storage?: PublishedImageStorage;
  },
): Promise<Response> {
  void request;
  try {
    const storage = options.storage ?? createVercelAttachmentStorage();
    const image = await readPublishedImage({
      extension: options.extension,
      sha256: options.sha256,
      storage,
    });
    if (!image) {
      return new Response("Not Found", { status: 404 });
    }
    return new Response(image.body, {
      headers: publishedImageHeaders({
        bytes: image.bytes,
        contentType: image.contentType,
      }),
      status: 200,
    });
  } catch (error) {
    logException(error, "published_images.get.exception");
    return new Response("Internal Server Error", { status: 500 });
  }
}
