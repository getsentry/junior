import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/chat/pi/client", () => ({
  completeText: vi.fn(),
  getGatewayApiKey: vi.fn(
    () => process.env.AI_GATEWAY_API_KEY ?? process.env.VERCEL_OIDC_TOKEN,
  ),
  resolveGatewayModel: vi.fn((modelId: string) => modelId),
  MISSING_GATEWAY_CREDENTIALS_ERROR:
    "Missing AI gateway credentials (AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN)",
}));

vi.mock("@/chat/prompt", () => ({
  JUNIOR_PERSONALITY: "test persona",
}));

import { completeText } from "@/chat/pi/client";
import { createImageGenerateTool } from "@/chat/tools/web/image-generate";

const mockCompleteText = vi.mocked(completeText);

function getRequestBody(fetchMock: ReturnType<typeof vi.fn>) {
  const request = fetchMock.mock.calls[0];
  expect(request).toBeDefined();
  expect(request[1]).toBeDefined();
  return JSON.parse((request[1] as RequestInit).body as string);
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
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_OIDC_TOKEN;
    delete process.env.AI_IMAGE_MODEL;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("uses the default image model when AI_IMAGE_MODEL is not set", async () => {
    process.env.AI_GATEWAY_API_KEY = "test-key";
    mockCompleteText.mockResolvedValueOnce({ text: "enriched prompt" } as any);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(createJsonResponse(imagePayload()));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(Date, "now").mockReturnValue(1_737_000_000_000);

    const uploads: Array<{ filename: string }> = [];
    const tool = createImageGenerateTool({
      onGeneratedArtifactFiles: (files: Array<{ filename: string }>) => {
        uploads.push(...files.map((file) => ({ filename: file.filename })));
      },
    } as any);
    if (typeof tool.execute !== "function") {
      throw new Error("imageGenerate execute function missing");
    }

    const result = await tool.execute({ prompt: "test prompt" }, {} as any);

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
    process.env.AI_GATEWAY_API_KEY = "test-key";
    process.env.AI_IMAGE_MODEL = "openai/dall-e-3";
    mockCompleteText.mockResolvedValueOnce({ text: "enriched cat" } as any);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(createJsonResponse(imagePayload()));
    vi.stubGlobal("fetch", fetchMock);

    const tool = createImageGenerateTool({} as any);
    if (typeof tool.execute !== "function") {
      throw new Error("imageGenerate execute function missing");
    }
    const result = await tool.execute({ prompt: "a cat" }, {} as any);

    expect(getRequestBody(fetchMock)).toMatchObject({
      model: "openai/dall-e-3",
    });
    expect(result).toMatchObject({
      ok: true,
      model: "openai/dall-e-3",
    });
  });

  it("returns an actionable error when model is not image-capable", async () => {
    process.env.AI_GATEWAY_API_KEY = "test-key";
    process.env.AI_IMAGE_MODEL = "google/gemini-3-pro-image";
    mockCompleteText.mockResolvedValueOnce({ text: "enriched prompt" } as any);
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
    vi.stubGlobal("fetch", fetchMock);

    const tool = createImageGenerateTool({} as any);
    if (typeof tool.execute !== "function") {
      throw new Error("imageGenerate execute function missing");
    }
    await expect(
      tool.execute({ prompt: "person in a forest" }, {} as any),
    ).rejects.toThrow(
      'configured model "google/gemini-3-pro-image" is not an image generation model',
    );
  });

  it("forwards enriched prompt to image API when enrichment succeeds", async () => {
    process.env.AI_GATEWAY_API_KEY = "test-key";
    mockCompleteText.mockResolvedValueOnce({
      text: "a dark, high-contrast dog with glowing eyes",
    } as any);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(createJsonResponse(imagePayload()));
    vi.stubGlobal("fetch", fetchMock);

    const tool = createImageGenerateTool({
      onGeneratedArtifactFiles: vi.fn(),
    } as any);
    const result = await tool.execute!({ prompt: "draw a dog" }, {} as any);

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
    process.env.AI_GATEWAY_API_KEY = "test-key";
    mockCompleteText.mockResolvedValueOnce({ text: "   " } as any);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(createJsonResponse(imagePayload()));
    vi.stubGlobal("fetch", fetchMock);

    const tool = createImageGenerateTool({
      onGeneratedArtifactFiles: vi.fn(),
    } as any);
    const result = await tool.execute!({ prompt: "draw a dog" }, {} as any);

    const body = getRequestBody(fetchMock);
    expect(body.messages[0].content).toBe("draw a dog");
    expect(result).toMatchObject({
      prompt: "draw a dog",
      enrichedPrompt: "draw a dog",
    });
  });

  it("falls back to raw prompt when enrichment fails", async () => {
    process.env.AI_GATEWAY_API_KEY = "test-key";
    mockCompleteText.mockRejectedValueOnce(new Error("LLM unavailable"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(createJsonResponse(imagePayload()));
    vi.stubGlobal("fetch", fetchMock);

    const tool = createImageGenerateTool({
      onGeneratedArtifactFiles: vi.fn(),
    } as any);
    const result = await tool.execute!({ prompt: "draw a dog" }, {} as any);

    const body = getRequestBody(fetchMock);
    expect(body.messages[0].content).toBe("draw a dog");
    expect(result).toMatchObject({
      prompt: "draw a dog",
      enrichedPrompt: "draw a dog",
    });
  });
});
