import type { FileUpload } from "chat";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/chat/pi/client", () => ({
  completeText: vi.fn(),
  resolveGatewayModel: vi.fn((modelId: string) => modelId),
  MISSING_GATEWAY_CREDENTIALS_ERROR:
    "Missing AI gateway credentials (enable Vercel OIDC or set AI_GATEWAY_API_KEY)",
}));

vi.mock("@/chat/pi/gateway-auth", () => ({
  resolveGatewayCredential: vi.fn(async () =>
    process.env.AI_GATEWAY_API_KEY
      ? { mode: "api_key", token: process.env.AI_GATEWAY_API_KEY }
      : undefined,
  ),
}));

vi.mock("@/chat/prompt", () => ({
  JUNIOR_PERSONALITY: "test persona",
}));

import { completeText } from "@/chat/pi/client";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import { createImageGenerateTool } from "@/chat/tools/web/image-generate";

const mockCompleteText = vi.mocked(completeText);
const PNG_BYTES = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

function sandbox(files: Record<string, Buffer> = {}): SandboxWorkspace {
  return {
    readFileToBuffer: vi.fn(async ({ path }) => files[path] ?? null),
    runCommand: vi.fn(),
    writeFiles: vi.fn(),
  };
}

const defaultImageOptions = {
  modelId: "openai/gpt-image-2",
  sandbox: sandbox(),
};

const IMAGE_MODEL_URL = "https://ai-gateway.vercel.sh/v4/ai/image-model";

function imageResponse(images = [PNG_BYTES]) {
  return Response.json({
    images: images.map((image) => image.toString("base64")),
  });
}

/** Fake AI Gateway that answers each image request in order. */
function gatewayFetch(responses: Response[]) {
  const queue = [...responses];
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) => queue.shift()!,
  );
}

function requestBody(fetchMock: ReturnType<typeof gatewayFetch>, index = 0) {
  const request = fetchMock.mock.calls[index]!;
  expect(String(request[0])).toBe(IMAGE_MODEL_URL);
  return JSON.parse(request[1]!.body as string);
}

function writeGeneratedArtifacts(files: FileUpload[]) {
  return files.map((file) => ({
    bytes: Buffer.isBuffer(file.data) ? file.data.byteLength : 0,
    filename: file.filename,
    mimeType: file.mimeType,
    path: `/tmp/junior/artifacts/${file.filename}`,
  }));
}

describe("createImageGenerateTool", () => {
  afterEach(() => {
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_OIDC_TOKEN;
    vi.clearAllMocks();
  });

  it("uses the configured image generation model", async () => {
    process.env.AI_GATEWAY_API_KEY = "test-key";
    mockCompleteText.mockResolvedValueOnce({ text: "enriched prompt" } as any);
    const fetchMock = gatewayFetch([imageResponse()]);
    vi.spyOn(Date, "now").mockReturnValue(1_737_000_000_000);

    const uploads: FileUpload[] = [];
    const tool = createImageGenerateTool(
      {
        writeGeneratedArtifacts: (files: FileUpload[]) => {
          uploads.push(...files);
          return writeGeneratedArtifacts(files);
        },
      },
      { modelId: "openai/gpt-image-1.5", sandbox: sandbox() },
      { fetch: fetchMock },
    );

    const result = await tool.execute!({ prompt: "test prompt" }, {} as any);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestBody(fetchMock)).toMatchObject({
      prompt: "enriched prompt",
      n: 1,
    });
    const headers = new Headers(fetchMock.mock.calls[0]![1]!.headers);
    expect(headers.get("ai-model-id")).toBe("openai/gpt-image-1.5");
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(result).toMatchObject({
      model: "openai/gpt-image-1.5",
      image_count: 1,
      images: [
        {
          bytes: PNG_BYTES.byteLength,
          filename: "generated-image-1737000000000-1.png",
          mimeType: "image/png",
          path: "/tmp/junior/artifacts/generated-image-1737000000000-1.png",
        },
      ],
      delivery: expect.stringContaining("no file-send tool"),
    });
    expect(JSON.stringify(result)).not.toContain("sendFiles");
    expect(uploads[0]?.data).toEqual(PNG_BYTES);
  });

  it("recommends sendFiles when active file-send support is available", async () => {
    process.env.AI_GATEWAY_API_KEY = "test-key";
    mockCompleteText.mockResolvedValueOnce({ text: "enriched prompt" } as any);

    const tool = createImageGenerateTool(
      { writeGeneratedArtifacts },
      { ...defaultImageOptions, canSendFilesToActiveConversation: true },
      { fetch: gatewayFetch([imageResponse()]) },
    );
    const result = await tool.execute!({ prompt: "test prompt" }, {} as any);

    expect(result).toMatchObject({
      image_count: 1,
      delivery: expect.stringContaining(
        "pass the returned image objects unchanged",
      ),
    });
  });

  it("returns an actionable error when model is not image-capable", async () => {
    process.env.AI_GATEWAY_API_KEY = "test-key";
    mockCompleteText.mockResolvedValueOnce({ text: "enriched prompt" } as any);
    const fetchMock = gatewayFetch([
      Response.json(
        {
          error: {
            type: "invalid_request_error",
            message:
              "Model 'google/gemini-3-pro-image' is a language model, not an image model. Use the language generation API instead.",
          },
        },
        { status: 400 },
      ),
    ]);

    const tool = createImageGenerateTool(
      { writeGeneratedArtifacts },
      { modelId: "google/gemini-3-pro-image", sandbox: sandbox() },
      { fetch: fetchMock },
    );
    await expect(
      tool.execute!({ prompt: "person in a forest" }, {} as any),
    ).rejects.toThrow(
      'configured model "google/gemini-3-pro-image" is not an image generation model',
    );
  });

  it("forwards enriched prompt to image API when enrichment succeeds", async () => {
    process.env.AI_GATEWAY_API_KEY = "test-key";
    mockCompleteText.mockResolvedValueOnce({
      text: "a dark, high-contrast dog with glowing eyes",
    } as any);
    const fetchMock = gatewayFetch([imageResponse()]);

    const tool = createImageGenerateTool(
      { writeGeneratedArtifacts },
      defaultImageOptions,
      { fetch: fetchMock },
    );
    const result = await tool.execute!({ prompt: "draw a dog" }, {} as any);

    expect(requestBody(fetchMock).prompt).toBe(
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
    const fetchMock = gatewayFetch([imageResponse()]);

    const tool = createImageGenerateTool(
      { writeGeneratedArtifacts },
      defaultImageOptions,
      { fetch: fetchMock },
    );
    const result = await tool.execute!({ prompt: "draw a dog" }, {} as any);

    expect(requestBody(fetchMock).prompt).toBe("draw a dog");
    expect(result).toMatchObject({ enrichedPrompt: "draw a dog" });
  });

  it("falls back to raw prompt when enrichment fails", async () => {
    process.env.AI_GATEWAY_API_KEY = "test-key";
    mockCompleteText.mockRejectedValueOnce(new Error("LLM unavailable"));
    const fetchMock = gatewayFetch([imageResponse()]);

    const tool = createImageGenerateTool(
      { writeGeneratedArtifacts },
      defaultImageOptions,
      { fetch: fetchMock },
    );
    const result = await tool.execute!({ prompt: "draw a dog" }, {} as any);

    expect(requestBody(fetchMock).prompt).toBe("draw a dog");
    expect(result).toMatchObject({ enrichedPrompt: "draw a dog" });
  });

  it("sends input images with the unchanged prompt", async () => {
    process.env.AI_GATEWAY_API_KEY = "test-key";
    const fetchMock = gatewayFetch([imageResponse()]);

    const tool = createImageGenerateTool(
      { writeGeneratedArtifacts },
      {
        ...defaultImageOptions,
        sandbox: sandbox({ "/vercel/sandbox/photo.png": PNG_BYTES }),
      },
      { fetch: fetchMock },
    );
    const result = await tool.execute!(
      { prompt: "change the sign text", images: ["photo.png"] },
      {} as any,
    );

    expect(mockCompleteText).not.toHaveBeenCalled();
    const body = requestBody(fetchMock);
    expect(body.prompt).toBe("change the sign text");
    expect(body.files).toEqual([
      expect.objectContaining({ data: PNG_BYTES.toString("base64") }),
    ]);
    expect(result).toMatchObject({
      enrichedPrompt: "change the sign text",
      image_count: 1,
    });
  });

  it("returns no images when the model generates none", async () => {
    process.env.AI_GATEWAY_API_KEY = "test-key";
    mockCompleteText.mockResolvedValueOnce({ text: "enriched prompt" } as any);

    const tool = createImageGenerateTool(
      { writeGeneratedArtifacts },
      defaultImageOptions,
      {
        fetch: gatewayFetch([
          Response.json({ images: [], isRetryable: false }),
        ]),
      },
    );
    const result = await tool.execute!({ prompt: "draw a dog" }, {} as any);

    expect(result).toMatchObject({
      image_count: 0,
      images: [],
      delivery: "No images were generated.",
    });
  });

  it("resizes input images over the request size limit", async () => {
    process.env.AI_GATEWAY_API_KEY = "test-key";
    const fetchMock = gatewayFetch([imageResponse()]);
    // Random pixels do not compress, so this PNG is about 9 MB.
    const largePng = await sharp({
      create: {
        width: 3000,
        height: 1000,
        channels: 3,
        background: "#808080",
        noise: { type: "gaussian", mean: 128, sigma: 60 },
      },
    })
      .png()
      .toBuffer();
    expect(largePng.byteLength).toBeGreaterThan(3 * 1024 * 1024);

    const tool = createImageGenerateTool(
      { writeGeneratedArtifacts },
      {
        ...defaultImageOptions,
        sandbox: sandbox({
          "/vercel/sandbox/photo.png": largePng,
          "/vercel/sandbox/logo.png": PNG_BYTES,
          "/vercel/sandbox/icon.png": PNG_BYTES,
          "/vercel/sandbox/badge.png": PNG_BYTES,
        }),
      },
      { fetch: fetchMock },
    );
    const result = await tool.execute!(
      {
        prompt: "change the sign",
        images: ["photo.png", "logo.png", "icon.png", "badge.png"],
      },
      {} as any,
    );

    const [sentPhoto, sentLogo] = requestBody(fetchMock).files;
    expect(sentPhoto.mediaType).toBe("image/jpeg");
    const photoBytes = Buffer.from(sentPhoto.data, "base64");
    // The small images leave their unused bytes to the photo, so it keeps
    // the largest size. An equal share would shrink it further.
    expect(await sharp(photoBytes).metadata()).toMatchObject({
      format: "jpeg",
      width: 2048,
    });
    expect(sentLogo.data).toBe(PNG_BYTES.toString("base64"));
    expect(result).toMatchObject({
      resized_images: [
        {
          path: "photo.png",
          original_bytes: largePng.byteLength,
          bytes: photoBytes.byteLength,
        },
      ],
      resize_notice: expect.stringContaining("Tell the user"),
    });
  });

  it("rejects input images too large to read before calling the gateway", async () => {
    process.env.AI_GATEWAY_API_KEY = "test-key";
    const fetchMock = gatewayFetch([]);

    const tool = createImageGenerateTool(
      { writeGeneratedArtifacts },
      {
        ...defaultImageOptions,
        sandbox: sandbox({
          "/vercel/sandbox/photo.png": Buffer.concat([
            PNG_BYTES,
            Buffer.alloc(25 * 1024 * 1024),
          ]),
        }),
      },
      { fetch: fetchMock },
    );

    await expect(
      tool.execute!(
        { prompt: "change the sign", images: ["photo.png"] },
        {} as any,
      ),
    ).rejects.toThrow("exceeds 26214400 bytes");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
