import { beforeEach, expect, it, vi } from "vitest";
import {
  observationBatchResults,
  submitObservationBatch,
} from "@/chat/distillation/batch";

const gateway = vi.hoisted(() => ({
  create: vi.fn(() => ({
    experimental_batch: vi.fn(),
    getGenerationInfo: gateway.generation,
  })),
  generation: vi.fn(),
  results: vi.fn(),
  start: vi.fn(),
}));

vi.mock("@ai-sdk/gateway-batch", () => ({
  createGatewayProvider: gateway.create,
}));
vi.mock("ai-batch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai-batch")>()),
  experimental_getBatchResults: gateway.results,
  experimental_startBatch: gateway.start,
}));

beforeEach(() => {
  vi.clearAllMocks();
  gateway.start.mockResolvedValue({
    version: 2,
    id: "gateway-batch-1",
    provider: "vercel-ai-gateway.batch",
    status: "pending",
    warnings: [],
  });
});

it("stops reading a provider result stream beyond the submitted request count", async () => {
  gateway.generation.mockResolvedValue({
    totalCost: 0.001,
    upstreamInferenceCost: 0,
    isByok: false,
  });
  gateway.results.mockImplementation(async function* () {
    for (const id of ["segment:1:1", "segment:2:2"]) {
      yield {
        type: "text",
        id,
        status: "succeeded",
        text: "<observations>work</observations>",
        response: { id },
        usage: { inputTokens: 30, outputTokens: 10 },
      };
    }
  });
  await expect(
    observationBatchResults(
      {
        version: 2,
        id: "gateway-batch-1",
        provider: "vercel-ai-gateway.batch",
      },
      1,
    ),
  ).rejects.toThrow("too many results");
  expect(gateway.generation).toHaveBeenCalledOnce();
});

it("submits each complete observation through the shared Gateway with a private retry key", async () => {
  const requests = [
    { id: "segment:1:2", system: "observe", prompt: "one" },
    { id: "segment:3:4", system: "observe", prompt: "two" },
  ];
  const input = {
    conversationId: "local:secret-conversation",
    historyVersion: 2,
    requests,
  };
  await expect(submitObservationBatch(input)).resolves.toMatchObject({
    id: "gateway-batch-1",
    version: 2,
  });
  await submitObservationBatch(input);
  const submitted = gateway.start.mock.calls[0]?.[0];
  expect(submitted.providerOptions.gateway.idempotencyKey).toBe(
    gateway.start.mock.calls[1]?.[0].providerOptions.gateway.idempotencyKey,
  );
  expect(submitted.providerOptions.gateway.idempotencyKey).not.toContain(
    input.conversationId,
  );
  expect(submitted.requests).toMatchObject([
    {
      id: "segment:1:2",
      model: "openai/gpt-6-luna",
      reasoning: "none",
      system: "observe",
      prompt: "one",
      type: "text",
    },
    {
      id: "segment:3:4",
      model: "openai/gpt-6-luna",
      reasoning: "none",
      system: "observe",
      prompt: "two",
      type: "text",
    },
  ]);
  await submitObservationBatch({
    ...input,
    requests: requests.slice(0, 1),
  });
  expect(
    gateway.start.mock.calls[2]?.[0].providerOptions.gateway.idempotencyKey,
  ).not.toBe(submitted.providerOptions.gateway.idempotencyKey);
});
