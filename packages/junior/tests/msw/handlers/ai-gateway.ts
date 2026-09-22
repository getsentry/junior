import { HttpResponse, http } from "msw";

const GATEWAY_EMBEDDING_URL =
  "https://ai-gateway.vercel.sh/v3/ai/embedding-model";
const EMBEDDING_DIMENSIONS = 1536;

function unitEmbedding(): number[] {
  const embedding = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0);
  embedding[0] = 1;
  return embedding;
}

/**
 * Deterministic AI Gateway embedding fixture for core tests.
 *
 * Memory recall embeds the user prompt on every Turn. Core tests must not
 * reach the live gateway for that call; evals keep live embeddings by not
 * loading this handler.
 */
export const aiGatewayEmbeddingHandlers = [
  http.post(GATEWAY_EMBEDDING_URL, async ({ request }) => {
    const body = (await request.json()) as { values?: unknown };
    const values = Array.isArray(body.values) ? body.values : [];
    return HttpResponse.json({
      embeddings: values.map(() => unitEmbedding()),
      usage: { tokens: values.length },
    });
  }),
];
