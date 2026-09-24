import { streamSimple, type Context } from "@earendil-works/pi-ai/compat";
import { z } from "zod";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";

/** Replay only the handoff decision; summarization and continuation stay live. */
export function startHandoffReplay(): typeof streamSimple {
  let started = false;
  return (model, context, options) => {
    if (started) return streamSimple(model, context, options);
    started = true;
    const profile = targetProfile(context);
    const trigger = createFauxCore({ api: "eval", provider: "eval" });
    trigger.setResponses([
      fauxAssistantMessage(fauxToolCall("handoff", { profile }), {
        stopReason: "toolUse",
      }),
    ]);
    return trigger.stream(model, context, options);
  };
}

function targetProfile(context: Context): string {
  const schema = context.tools?.find(
    (tool) => tool.name === "handoff",
  )?.parameters;
  const { properties } = z
    .object({
      properties: z.object({
        profile: z.object({ enum: z.array(z.string()).min(1) }),
      }),
    })
    .parse(schema);
  const profiles = properties.profile.enum;
  // The router can already select handoff. In that case switch back to standard
  // so this case always exercises history replacement rather than a no-op.
  const profile = profiles.includes("handoff") ? "handoff" : profiles[0];
  if (!profile)
    throw new Error("Handoff replay requires another model profile");
  return profile;
}
