import { afterEach, describe, expect, it, vi } from "vitest";
import { createImageGenerateTool } from "@/chat/tools/image-generate";

function createJsonResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => payload
  } as Response;
}

function createErrorResponse(status: number, body: string) {
  return {
    ok: false,
    status,
    text: async () => body
  } as Response;
}

describe("createImageGenerateTool", () => {
  afterEach(() => {
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_OIDC_TOKEN;
    delete process.env.AI_IMAGE_MODEL;
    vi.unstubAllGlobals();
  });

  it("uses the default image model when AI_IMAGE_MODEL is not set", async () => {
    process.env.AI_GATEWAY_API_KEY = "test-key";
    const fetchMock = vi.fn().mockResolvedValueOnce(
      createJsonResponse({
        choices: [
          {
            message: {
              images: [{ image_url: { url: `data:image/png;base64,${Buffer.from("img").toString("base64")}` } }]
            }
          }
        ]
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(Date, "now").mockReturnValue(1_737_000_000_000);

    const uploads: Array<{ filename: string }> = [];
    const tool = createImageGenerateTool({
      onGeneratedFiles: (files: Array<{ filename: string }>) => {
        uploads.push(...files.map((file) => ({ filename: file.filename })));
      }
    } as any);
    if (typeof tool.execute !== "function") {
      throw new Error("imageGenerate execute function missing");
    }

    const result = await tool.execute({ prompt: "test prompt" }, {} as any);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0];
    expect(request?.[0]).toBe("https://ai-gateway.vercel.sh/v1/chat/completions");
    expect(JSON.parse((request?.[1] as RequestInit).body as string)).toMatchObject({
      model: "google/gemini-3-pro-image",
      messages: [{ role: "user", content: "test prompt" }],
      modalities: ["image"]
    });
    expect(result).toMatchObject({
      ok: true,
      model: "google/gemini-3-pro-image",
      image_count: 1
    });
    expect(uploads[0]?.filename).toContain("generated-image-1737000000000-1");
  });

  it("uses AI_IMAGE_MODEL when configured", async () => {
    process.env.AI_GATEWAY_API_KEY = "test-key";
    process.env.AI_IMAGE_MODEL = "openai/dall-e-3";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        createJsonResponse({
          choices: [
            {
              message: {
                images: [{ image_url: { url: `data:image/png;base64,${Buffer.from("img").toString("base64")}` } }]
              }
            }
          ]
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const tool = createImageGenerateTool({} as any);
    if (typeof tool.execute !== "function") {
      throw new Error("imageGenerate execute function missing");
    }
    const result = await tool.execute({ prompt: "a cat" }, {} as any);

    const request = fetchMock.mock.calls[0];
    expect(JSON.parse((request?.[1] as RequestInit).body as string)).toMatchObject({
      model: "openai/dall-e-3"
    });
    expect(result).toMatchObject({
      ok: true,
      model: "openai/dall-e-3"
    });
  });

  it("returns an actionable error when model is not image-capable", async () => {
    process.env.AI_GATEWAY_API_KEY = "test-key";
    process.env.AI_IMAGE_MODEL = "google/gemini-3-pro-image";
    const fetchMock = vi.fn().mockResolvedValueOnce(
      createErrorResponse(
        400,
        JSON.stringify({
          error: {
            message:
              "Model 'google/gemini-3-pro-image' is a language model, not an image model. Use the language generation API instead."
          }
        })
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = createImageGenerateTool({} as any);
    if (typeof tool.execute !== "function") {
      throw new Error("imageGenerate execute function missing");
    }
    await expect(tool.execute({ prompt: "person in a forest" }, {} as any)).rejects.toThrow(
      'configured model "google/gemini-3-pro-image" is not an image generation model'
    );
  });
});
