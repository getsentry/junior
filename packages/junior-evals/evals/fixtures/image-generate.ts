import type { ImageGenerateToolDeps } from "@/chat/tools/types";

const STUB_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH3cAAAAASUVORK5CYII=";

/** Return a mock `ImageGenerateToolDeps` that responds with a 1×1 PNG. */
export function createMockImageGenerateDeps(): ImageGenerateToolDeps {
  return {
    fetch: async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url === "https://ai-gateway.vercel.sh/v1/chat/completions") {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  images: [
                    {
                      image_url: {
                        url: `data:image/png;base64,${STUB_PNG_BASE64}`,
                      },
                    },
                  ],
                },
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return fetch(input, init);
    },
  };
}
