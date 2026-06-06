import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createImageGenerateTool } from "@/chat/tools/web/image-generate";
import { mockTestClock, stubTestEnv } from "../../fixtures/vitest";

type ImageGenerateHooks = Parameters<typeof createImageGenerateTool>[0];
type ImageGenerateDeps = NonNullable<
  Parameters<typeof createImageGenerateTool>[1]
>;
type ImageGenerateTool = ReturnType<typeof createImageGenerateTool>;
type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;
type CompleteTextResult = Awaited<
  ReturnType<NonNullable<ImageGenerateDeps["completeText"]>>
>;

const completeText = vi.fn<NonNullable<ImageGenerateDeps["completeText"]>>();

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
    completeText,
    fetch: fetchMock,
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

function completion(text: string): CompleteTextResult {
  return { text } as CompleteTextResult;
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

function requireExecute(tool: ImageGenerateTool) {
  const execute = tool.execute;
  if (!execute) {
    throw new Error("imageGenerate execute function missing");
  }
  return execute;
}

async function executeImageGenerate(tool: ImageGenerateTool, prompt: string) {
  return await requireExecute(tool)({ prompt }, {});
}

describe("createImageGenerateTool", () => {
  beforeEach(() => {
    stubTestEnv({ AI_GATEWAY_API_KEY: "test-key" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("uses the default image model when AI_IMAGE_MODEL is not set", async () => {
    mockTestClock(1_737_000_000_000);
    completeText.mockResolvedValueOnce(completion("enriched prompt"));
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createJsonResponse(imagePayload()));

    const uploads: Array<{ filename: string }> = [];
    const hooks: ImageGenerateHooks = {
      onGeneratedArtifactFiles: (files: Array<{ filename: string }>) => {
        uploads.push(...files.map((file) => ({ filename: file.filename })));
      },
    };
    const tool = createImageGenerateTool(hooks, createImageDeps(fetchMock));
    const result = await executeImageGenerate(tool, "test prompt");

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
    stubTestEnv({ AI_IMAGE_MODEL: "openai/dall-e-3" });
    completeText.mockResolvedValueOnce(completion("enriched cat"));
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createJsonResponse(imagePayload()));

    const tool = createImageGenerateTool({}, createImageDeps(fetchMock));
    const result = await executeImageGenerate(tool, "a cat");

    expect(getRequestBody(fetchMock)).toMatchObject({
      model: "openai/dall-e-3",
    });
    expect(result).toMatchObject({
      ok: true,
      model: "openai/dall-e-3",
    });
  });

  it("returns an actionable error when model is not image-capable", async () => {
    stubTestEnv({ AI_IMAGE_MODEL: "google/gemini-3-pro-image" });
    completeText.mockResolvedValueOnce(completion("enriched prompt"));
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
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
    await expect(
      executeImageGenerate(tool, "person in a forest"),
    ).rejects.toThrow(
      'configured model "google/gemini-3-pro-image" is not an image generation model',
    );
  });

  it("forwards enriched prompt to image API when enrichment succeeds", async () => {
    completeText.mockResolvedValueOnce(
      completion("a dark, high-contrast dog with glowing eyes"),
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createJsonResponse(imagePayload()));

    const tool = createImageGenerateTool(
      {
        onGeneratedArtifactFiles: vi.fn(),
      },
      createImageDeps(fetchMock),
    );
    const result = await executeImageGenerate(tool, "draw a dog");

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
    completeText.mockResolvedValueOnce(completion("   "));
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createJsonResponse(imagePayload()));

    const tool = createImageGenerateTool(
      {
        onGeneratedArtifactFiles: vi.fn(),
      },
      createImageDeps(fetchMock),
    );
    const result = await executeImageGenerate(tool, "draw a dog");

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
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createJsonResponse(imagePayload()));

    const tool = createImageGenerateTool(
      {
        onGeneratedArtifactFiles: vi.fn(),
      },
      createImageDeps(fetchMock),
    );
    const result = await executeImageGenerate(tool, "draw a dog");

    const body = getRequestBody(fetchMock);
    expect(body.messages[0].content).toBe("draw a dog");
    expect(result).toMatchObject({
      prompt: "draw a dog",
      enrichedPrompt: "draw a dog",
    });
  });
});
