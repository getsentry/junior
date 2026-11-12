import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalSource, type Identity } from "@sentry/junior-plugin-api";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import { apiErrorSchema, createdPersonalTokenSchema } from "@/api/schema";
import { turnBehavior } from "@/chat/conversations/kind-behavior";
import { closeDb } from "@/chat/db";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { createTools } from "@/chat/tools/index";
import type { ToolRuntimeContext } from "@/chat/tools/types";

const CONVERSATION_ID = "local:preview-handoff:current";
const PREVIEW_URL = "https://sb-handoff.vercel.run";
const IDENTITY: Identity = {
  id: "identity-1",
  provider: "slack",
  providerSubjectId: "U123",
};

async function unused(): Promise<never> {
  throw new Error("The Preview test does not use the Sandbox.");
}

async function viewer(email: string) {
  const user = await resolveViewerUser(email);
  if (!user) throw new Error(`missing viewer for ${email}`);
  return user;
}

async function createPreviewAs(email: string, url = PREVIEW_URL) {
  const user = await viewer(email);
  const tools = createTools([], {}, {
    conversationId: CONVERSATION_ID,
    destination: { platform: "local", conversationId: CONVERSATION_ID },
    egress: {
      async fetch() {
        return new Response("ok");
      },
    },
    resolveActorIdentity: async () => ({ identity: IDENTITY, user }),
    source: createLocalSource(CONVERSATION_ID),
    turnTools: turnBehavior({ kind: "root", personInput: true }).tools,
    workspace: {
      createPreview: async () => url,
      readFileToBuffer: unused,
      runCommand: unused,
      writeFiles: unused,
    },
  } as ToolRuntimeContext);
  const tool = tools.createPreview;
  if (!tool?.execute || !tool.prepareArguments) {
    throw new Error("createPreview is missing");
  }
  await tool.execute(tool.prepareArguments({ port: 3000 }), {});
}

function createToken(email: string, previewOrigin: string) {
  const app = new Hono<{ Variables: JuniorApiVariables }>();
  app.use("*", async (c, next) => {
    c.set("viewer", await viewer(email));
    await next();
  });
  app.route("/", createJuniorApi());
  return app.request("http://localhost/api/personal-tokens", {
    body: JSON.stringify({ name: "Live preview", previewOrigin }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

describe("personal token handoff to a Preview", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("creates a token only for the person who asked for the Preview", async () => {
    await createPreviewAs("owner@example.com");

    const owner = await createToken("Owner@example.com", PREVIEW_URL);
    const other = await createToken("other@example.com", PREVIEW_URL);

    expect(owner.status).toBe(200);
    expect(createdPersonalTokenSchema.parse(await owner.json()).token).toMatch(
      /^jr_pat_/,
    );
    expect(other.status).toBe(403);
    expect(apiErrorSchema.parse(await other.json())).toEqual({
      error: "Junior did not make this Preview for you.",
    });
  });

  it("rejects a Preview that Junior did not make", async () => {
    const response = await createToken(
      "owner@example.com",
      "https://sb-unknown.vercel.run",
    );

    expect(response.status).toBe(403);
  });

  it("rejects a preview URL that is not an origin", async () => {
    const response = await createToken(
      "owner@example.com",
      `${PREVIEW_URL}/steal`,
    );

    expect(response.status).toBe(400);
  });
});
