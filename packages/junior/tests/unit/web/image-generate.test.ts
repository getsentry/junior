import { afterEach, describe, expect, it, vi } from "vitest";
import { createImageGenerateTool } from "@/chat/tools/web/image-generate";

type ImageGenerateHooks = Parameters<typeof createImageGenerateTool>[0];
type ImageGenerateDeps = NonNullable<
  Parameters<typeof createImageGenerateTool>[1]
>;
type FetchMock = ReturnType<typeof vi.fn>;

const completeText = vi.fn();

function getRequestBody(fetchMock: FetchMock) {
  const request = fetchMock.mock.calls[0];
  expect(request).toBeDefined();
  expect(request[1]).toBeDefined();
  return JSON.parse((request[1] as RequestInit).body as string);
}

function createImageDeps(
  fetchMock: FetchMock,
  overrides: Partial<ImageGenerateDeps> = {},
): ImageGenerateDeps {
  return {
    completeText: completeText as NonNullable<
      ImageGenerateDeps["completeText"]
    >,
    fetch: fetchMock as unknown as typeof fetch,
    getGatewayApiKey: () => "test-key",
    ...overrides,
  };
}

function createJsonResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as Response;
}

function createErrorResponse(status: number, body: string) {
  return {
    ok: false,
    status,
    text: async () => body,
  } as Response;
}

function imagePayload() {
  return {
    choices: [
      {
        message: {
          images: [
            {
              image_url: {
                url: `data:image/png;base64,${Buffer.from("img").toString("base64")}`,
              },
            },
          ],
        },
      },
    ],
  };
}

describe("createImageGenerateTool", () => {
  afterEach(() => {
    delete process.env.AI_IMAGE_MODEL;
    vi.clearAllMocks();
  });

  it("uses the default image model when AI_IMAGE_MODEL is not set", async () => {
    completeText.mockResolvedValueOnce({ text: "enriched prompt" });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(createJsonResponse(imagePayload()));

    const uploads: Array<{ filename: string }> = [];
    const hooks: ImageGenerateHooks = {
      onGeneratedArtifactFiles: (files: Array<{ filename: string }>) => {
        uploads.push(...files.map((file) => ({ filename: file.filename })));
      },
    };
    const tool = createImageGenerateTool(
      hooks,
      createImageDeps(fetchMock, { now: () => 1_737_000_000_000 }),
    );
    if (typeof tool.execute !== "function") {
      throw new Error("imageGenerate execute function missing");
    }

    const result = await tool.execute({ prompt: "test prompt" }, {} as never);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0];
    expect(request).toBeDefined();
    expect(request[0]).toBe("https://ai-gateway.vercel.sh/v1/chat/completions");
    expect(getRequestBody(fetchMock)).toMatchObject({
      model: "google/gemini-3-pro-image",
      messages: [{ role: "user", content: "enriched prompt" }],
      modalities: ["image"],
    });
    expect(result).toMatchObject({
      ok: true,
      model: "google/gemini-3-pro-image",
      image_count: 1,
    });
    expect(result).toMatchObject({
      images: [
        expect.objectContaining({
          attachment_path: "generated-image-1737000000000-1.png",
        }),
      ],
    });
    expect(uploads[0]?.filename).toContain("generated-image-1737000000000-1");
  });

  it("uses AI_IMAGE_MODEL when configured", async () => {
    process.env.AI_IMAGE_MODEL = "openai/dall-e-3";
    completeText.mockResolvedValueOnce({ text: "enriched cat" });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(createJsonResponse(imagePayload()));

    const tool = createImageGenerateTool({}, createImageDeps(fetchMock));
    if (typeof tool.execute !== "function") {
      throw new Error("imageGenerate execute function missing");
    }
    const result = await tool.execute({ prompt: "a cat" }, {} as never);

    expect(getRequestBody(fetchMock)).toMatchObject({
      model: "openai/dall-e-3",
    });
    expect(result).toMatchObject({
      ok: true,
      model: "openai/dall-e-3",
    });
  });

  it("returns an actionable error when model is not image-capable", async () => {
    process.env.AI_IMAGE_MODEL = "google/gemini-3-pro-image";
    completeText.mockResolvedValueOnce({ text: "enriched prompt" });
    const fetchMock = vi.fn().mockResolvedValueOnce(
      createErrorResponse(
        400,
        JSON.stringify({
          error: {
            message:
              "Model 'google/gemini-3-pro-image' is a language model, not an image model. Use the language generation API instead.",
          },
        }),
      ),
    );

    const tool = createImageGenerateTool({}, createImageDeps(fetchMock));
    if (typeof tool.execute !== "function") {
      throw new Error("imageGenerate execute function missing");
    }
    await expect(
      tool.execute({ prompt: "person in a forest" }, {} as never),
    ).rejects.toThrow(
      'configured model "google/gemini-3-pro-image" is not an image generation model',
    );
  });

  it("forwards enriched prompt to image API when enrichment succeeds", async () => {
    completeText.mockResolvedValueOnce({
      text: "a dark, high-contrast dog with glowing eyes",
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(createJsonResponse(imagePayload()));

    const tool = createImageGenerateTool(
      {
        onGeneratedArtifactFiles: vi.fn(),
      },
      createImageDeps(fetchMock),
    );
    const result = await tool.execute!({ prompt: "draw a dog" }, {} as never);

    const body = getRequestBody(fetchMock);
    expect(body.messages[0].content).toBe(
      "a dark, high-contrast dog with glowing eyes",
    );
    expect(result).toMatchObject({
      prompt: "draw a dog",
      enrichedPrompt: "a dark, high-contrast dog with glowing eyes",
    });
  });

  it("falls back to raw prompt when enrichment returns empty text", async () => {
    completeText.mockResolvedValueOnce({ text: "   " });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(createJsonResponse(imagePayload()));

    const tool = createImageGenerateTool(
      {
        onGeneratedArtifactFiles: vi.fn(),
      },
      createImageDeps(fetchMock),
    );
    const result = await tool.execute!({ prompt: "draw a dog" }, {} as never);

    const body = getRequestBody(fetchMock);
    expect(body.messages[0].content).toBe("draw a dog");
    expect(result).toMatchObject({
      prompt: "draw a dog",
      enrichedPrompt: "draw a dog",
    });
  });

  it("falls back to raw prompt when enrichment fails", async () => {
    completeText.mockRejectedValueOnce(new Error("LLM unavailable"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(createJsonResponse(imagePayload()));

    const tool = createImageGenerateTool(
      {
        onGeneratedArtifactFiles: vi.fn(),
      },
      createImageDeps(fetchMock),
    );
    const result = await tool.execute!({ prompt: "draw a dog" }, {} as never);

    const body = getRequestBody(fetchMock);
    expect(body.messages[0].content).toBe("draw a dog");
    expect(result).toMatchObject({
      prompt: "draw a dog",
      enrichedPrompt: "draw a dog",
    });
  });
});
