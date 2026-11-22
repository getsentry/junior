// The AI emulator of the model tests: `emulate`'s AI service, in process on a
// free port. It answers model requests on the real Anthropic Messages wire,
// so pi-ai's `streamSimple` parses each reply as it does in production. Rules
// script the replies and inject faults. Vitest loads this module once per
// test file, so each test file gets its own emulator. Each test starts with
// no rules and no recorded calls.
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { createEmulator } from "emulate";
import { afterAll, afterEach } from "vitest";
import { resolveGatewayModel } from "@/chat/pi/client";
import { modelClient, type ModelClient } from "@/core/model/client";

type ModelReplyEvent =
  | { type: "text"; text: string }
  | {
      type: "tool_call";
      name: string;
      arguments: Record<string, unknown>;
      id?: string;
    };

/**
 * What the emulator answers to a model request. The first rule that matches
 * answers. `times` limits how often a rule answers. See the AI API section
 * of `emulate`'s README for every field.
 */
export type ModelRule = {
  match?: { stream?: boolean };
  times?: number;
  reply?: ModelReplyEvent[];
  error?: { status: number; message: string };
  fault?: { kind: "disconnect"; afterChunks: number };
};

/** One model request that the emulator answered. */
export type ModelCall = {
  stream: boolean;
  status: number;
  /** `none`, or the fault that a rule injected. */
  fault: string;
};

const emulator = await createEmulator({ service: "ai", port: 0 });

afterEach(async () => {
  await control("/_ai/reset", { method: "POST" });
});

afterAll(async () => {
  await emulator.close();
});

async function control(path: string, init: RequestInit = {}) {
  const response = await fetch(new URL(path, emulator.url), init);
  if (!response.ok) {
    throw new Error(
      `AI emulator ${init.method ?? "GET"} ${path} failed with ${response.status}: ${await response.text()}`,
    );
  }
  return (await response.json()) as unknown;
}

/** The production model client, with its requests sent to the emulator. */
export function emulatedModelClient(): ModelClient {
  return modelClient({
    apiKey: () => Promise.resolve("test-gateway-key"),
    resolveModel: (id) => ({
      ...resolveGatewayModel(id),
      baseUrl: emulator.url,
    }),
    send: streamSimple,
  });
}

/** Replaces the emulator's rules. The emulator needs an id for each rule. */
export async function setModelRules(rules: ModelRule[]): Promise<void> {
  await control("/_ai/rules", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      rules: rules.map((rule, index) => ({ ...rule, id: `rule-${index}` })),
    }),
  });
}

/** The model requests of the test so far, oldest first. */
export async function modelCalls(): Promise<ModelCall[]> {
  return (await control("/_ai/calls")) as ModelCall[];
}

/** Injected fault: the model provider answers 529 overloaded. */
export function modelOverloaded(): ModelRule {
  return { error: { status: 529, message: "Overloaded" } };
}

/** Injected fault: the stream closes after the first chunk of `text`. */
export function streamDisconnected(text: string): ModelRule {
  return {
    match: { stream: true },
    reply: [{ type: "text", text }],
    fault: { kind: "disconnect", afterChunks: 1 },
  };
}
