import type { ServedImage } from "@/chat/images/read";

// A versioned path names one image, so its bytes never change. `private`
// keeps images out of shared caches, because the image routes need a
// signed-in viewer.
const VERSIONED_CACHE_CONTROL = "private, max-age=31536000, immutable";
// The image behind an unversioned path can change. Keep it as long as the
// server cache does.
const UNVERSIONED_CACHE_CONTROL = "private, max-age=86400";

/** Send one served image with the headers of every Junior image route. */
export function imageResponse(
  served: ServedImage,
  versioned: boolean,
): Response {
  return new Response(Buffer.from(served.data, "base64"), {
    headers: {
      "cache-control": versioned
        ? VERSIONED_CACHE_CONTROL
        : UNVERSIONED_CACHE_CONTROL,
      "content-security-policy": "default-src 'none'; sandbox",
      "content-type": served.contentType,
      vary: "Authorization, Cookie",
      "x-content-type-options": "nosniff",
    },
  });
}
