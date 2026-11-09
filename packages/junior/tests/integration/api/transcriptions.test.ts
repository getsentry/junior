import { Hono } from "hono";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import { transcriptionSchema } from "@/api/schema";
import { closeDb } from "@/chat/db";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { mswServer } from "../../msw/server";

const GATEWAY_TRANSCRIPTION_URL =
  "https://ai-gateway.vercel.sh/v4/ai/transcription-model";

function api(email?: string) {
  const app = new Hono<{ Variables: JuniorApiVariables }>();
  app.use("*", async (c, next) => {
    if (email) {
      const viewer = await resolveViewerUser(email);
      if (!viewer) throw new Error(`missing viewer for ${email}`);
      c.set("viewer", viewer);
    }
    await next();
  });
  app.route("/", createJuniorApi());
  return app;
}

function postAudio(app: ReturnType<typeof api>, body: unknown) {
  return app.request("http://localhost/api/transcriptions", {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

function base64(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64");
}

function fakeGateway() {
  const requests: { body: unknown; modelId: string | null }[] = [];
  mswServer.use(
    http.post(GATEWAY_TRANSCRIPTION_URL, async ({ request }) => {
      requests.push({
        body: await request.json(),
        modelId: request.headers.get("ai-model-id"),
      });
      return HttpResponse.json({ text: "  Ship the dictation button.  " });
    }),
  );
  return requests;
}

describe("transcriptions API", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("transcribes a signed-in viewer's recording with the configured model", async () => {
    const requests = fakeGateway();
    // EBML header, so the AI SDK detects WebM.
    const audio = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);

    const response = await postAudio(api("person@example.com"), {
      audio: base64(audio),
    });

    expect(response.status).toBe(200);
    expect(transcriptionSchema.parse(await response.json())).toEqual({
      text: "Ship the dictation button.",
    });
    expect(requests).toEqual([
      {
        body: expect.objectContaining({
          audio: base64(audio),
          mediaType: "audio/webm",
        }),
        modelId: "spacexai/grok-stt",
      },
    ]);
  });

  it("tells the viewer when AI Gateway denies the model", async () => {
    mswServer.use(
      http.post(GATEWAY_TRANSCRIPTION_URL, () =>
        HttpResponse.json(
          {
            error: {
              message: "Add a payment method to use free credits.",
              type: "customer_verification_required",
            },
          },
          { status: 403 },
        ),
      ),
    );

    const response = await postAudio(api("person@example.com"), {
      audio: base64(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1])),
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: expect.stringContaining("denied access to this model"),
    });
  });

  it("rejects anonymous, malformed, empty, and oversized requests before the model", async () => {
    const requests = fakeGateway();
    const signedIn = api("person@example.com");

    const responses = await Promise.all([
      postAudio(api(), { audio: "AAAA" }),
      postAudio(signedIn, { audio: "not base64!" }),
      postAudio(signedIn, { audio: "" }),
      postAudio(signedIn, { audio: "A".repeat(4_500_000) }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      401, 400, 400, 413,
    ]);
    expect(requests).toEqual([]);
  });
});
