import { Hono } from "hono";
import { decodeImageId } from "@/chat/images/ids";
import { readImage } from "@/chat/images/read";
import { throwApiError } from "../http";
import type { JuniorApiEnv } from "../route";
import { imageParamsSchema, imageQuerySchema } from "../schema/image";
import { validateRequest } from "../validation";
import { requireViewer } from "../viewer";

// A versioned path names one image, so its bytes never change. `private`
// keeps images out of shared caches, because the route needs a signed-in
// viewer.
const VERSIONED_CACHE_CONTROL = "private, max-age=31536000, immutable";
// The image behind an unversioned path can change. Keep it as long as the
// server cache does.
const UNVERSIONED_CACHE_CONTROL = "private, max-age=86400";

/**
 * Create the route that serves external images from Junior, so browsers
 * never load them from another host. The path has a signed id, never the
 * address of the image.
 */
export function createImageRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();
  app.get(
    "/:id",
    requireViewer,
    validateRequest("param", imageParamsSchema, "Invalid route parameters."),
    validateRequest("query", imageQuerySchema, "Invalid image width."),
    async (context) => {
      const image = decodeImageId(context.req.valid("param").id);
      const { v, w } = context.req.valid("query");
      const served =
        image && (await readImage(context.get("viewer"), image, w));
      if (!served) throwApiError(404, "Image not found.");
      return new Response(Buffer.from(served.data, "base64"), {
        headers: {
          "cache-control": v
            ? VERSIONED_CACHE_CONTROL
            : UNVERSIONED_CACHE_CONTROL,
          "content-security-policy": "default-src 'none'; sandbox",
          "content-type": served.contentType,
          vary: "Authorization, Cookie",
          "x-content-type-options": "nosniff",
        },
      });
    },
  );
  return app;
}
