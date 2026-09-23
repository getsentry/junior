import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { EventPublisher, PluginRoute } from "@sentry/junior-plugin-api";
import { resolveGocdBaseUrl, type GocdPluginOptions } from "./config.js";

const name = z.string().regex(/^[A-Za-z0-9_-]{1,255}$/);
const failureSchema = z
  .object({
    pipeline: name,
    pipelineCounter: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    stage: name,
    stageCounter: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    result: z.literal("Failed"),
  })
  .strict();

/** Return the host-only secret used by the trusted GoCD notification adapter. */
export function gocdWebhookSecret(): string | undefined {
  return process.env.GOCD_WEBHOOK_SECRET?.trim() || undefined;
}

async function readBody(request: Request): Promise<Buffer | undefined> {
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks);
      size += value.byteLength;
      if (size > 4096) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

/** Receive signed stage failures from an operator-controlled GoCD adapter. */
export function createGocdWebhookRoute(
  events: EventPublisher,
  options: GocdPluginOptions,
): PluginRoute {
  return {
    method: "POST",
    path: "/api/webhooks/gocd",
    async handler(request) {
      const secret = gocdWebhookSecret();
      if (!secret)
        return new Response("GoCD events are not configured", { status: 503 });
      const timestamp = request.headers.get("x-junior-gocd-timestamp") ?? "";
      const signature = request.headers.get("x-junior-gocd-signature") ?? "";
      const seconds = Number(timestamp);
      if (
        !/^\d{10}$/.test(timestamp) ||
        Math.abs(Date.now() - seconds * 1000) > 5 * 60_000 ||
        !/^[0-9a-f]{64}$/.test(signature)
      )
        return new Response("Unauthorized", { status: 401 });
      // The adapter sends only run coordinates, never logs or instructions.
      const body = await readBody(request);
      if (!body) return new Response("Payload too large", { status: 413 });
      const expected = createHmac("sha256", secret)
        .update(`${timestamp}.`)
        .update(body)
        .digest();
      if (!timingSafeEqual(Buffer.from(signature, "hex"), expected)) {
        return new Response("Unauthorized", { status: 401 });
      }
      let value: unknown;
      try {
        value = JSON.parse(body.toString("utf8"));
      } catch {
        return new Response("Malformed GoCD event", { status: 400 });
      }
      const parsed = failureSchema.safeParse(value);
      if (!parsed.success)
        return new Response("Malformed GoCD event", { status: 400 });
      const { pipeline, pipelineCounter, stage, stageCounter } = parsed.data;
      const baseUrl = resolveGocdBaseUrl(options);
      const identifier = `${baseUrl}/go/pipelines/${pipeline}`;
      const runUrl = `${identifier}/${pipelineCounter}/${stage}/${stageCounter}`;
      await events.publish({
        eventType: "stage.failed",
        eventKey: `${runUrl}:failed`,
        identifier,
        occurredAtMs: seconds * 1000,
        trustedSummary: `GoCD ${pipeline}/${pipelineCounter}/${stage}/${stageCounter} failed.`,
        data: { ...parsed.data, baseUrl, runUrl },
      });
      return new Response("Accepted", { status: 202 });
    },
  };
}
