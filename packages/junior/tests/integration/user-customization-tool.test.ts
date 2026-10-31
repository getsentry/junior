import { afterEach, describe, expect, it } from "vitest";
import { createLocalSource, type Identity } from "@sentry/junior-plugin-api";
import { closeDb } from "@/chat/db";
import { setExperimentalFeatures } from "@/chat/experimental";
import { readUserCustomization } from "@/chat/identities/customization";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { createUserCustomizationTools } from "@/chat/tools/user-customization";
import { SUITE_EXPERIMENTAL } from "../fixtures/experimental-setup";

const CONVERSATION_ID = "local:user-customization:current";
const IDENTITY: Identity = {
  id: "identity-1",
  provider: "slack",
  providerSubjectId: "U123",
};

function context(
  overrides: Partial<ToolRuntimeContext> = {},
): ToolRuntimeContext {
  return {
    conversationId: CONVERSATION_ID,
    destination: { platform: "local", conversationId: CONVERSATION_ID },
    source: createLocalSource(CONVERSATION_ID),
    egress: {
      async fetch() {
        return new Response("ok");
      },
    },
    workspace: {} as ToolRuntimeContext["workspace"],
    ...overrides,
  } as ToolRuntimeContext;
}

async function updateCustomization(
  runtime: ToolRuntimeContext,
  customization: string,
): Promise<unknown> {
  const tool = createUserCustomizationTools(runtime).updateUserCustomization;
  if (!tool?.execute || !tool.prepareArguments) {
    throw new Error("updateUserCustomization is missing");
  }
  return await tool.execute(tool.prepareArguments({ customization }), {});
}

describe("user customization tool", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("exists only when the app opts in, and never for child agents", () => {
    expect(createUserCustomizationTools(context())).toEqual({});

    setExperimentalFeatures({
      ...SUITE_EXPERIMENTAL,
      "user-customization": true,
    });
    expect(Object.keys(createUserCustomizationTools(context()))).toEqual([
      "updateUserCustomization",
    ]);
    expect(
      createUserCustomizationTools(
        context({ source: { kind: "agent_invocation" } }),
      ),
    ).toEqual({});
  });

  it("replaces the current user's text and rejects people without a user", async () => {
    setExperimentalFeatures({
      ...SUITE_EXPERIMENTAL,
      "user-customization": true,
    });
    const user = await resolveViewerUser("person@example.com");
    if (!user) throw new Error("missing user");
    const runtime = context({
      resolveActorIdentity: async () => ({ identity: IDENTITY, user }),
    });

    await updateCustomization(runtime, "Keep replies short.");
    expect(await readUserCustomization(user.id)).toBe("Keep replies short.");
    await updateCustomization(runtime, "");
    expect(await readUserCustomization(user.id)).toBeUndefined();

    await expect(
      updateCustomization(
        context({ resolveActorIdentity: async () => ({ identity: IDENTITY }) }),
        "Keep replies short.",
      ),
    ).rejects.toBeInstanceOf(ToolInputError);
  });
});
