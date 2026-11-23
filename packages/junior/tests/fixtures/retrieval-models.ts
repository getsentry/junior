import { http, HttpResponse } from "msw";
import { mswServer } from "../msw/server";

const GATEWAY_URL = "https://ai-gateway.vercel.sh/v4/ai";

/** One reranking request that the model service received. */
export type RerankRequest = { documents: string[]; query: string };

type RetrievalModelOptions = {
  /** Score for one document, or nothing to reject the request. */
  rerank: (query: string, document: string) => number | undefined;
};

/** Answer every embedding call of the model service with `vectorFor(text)`. */
export function mockEmbeddings(
  vectorFor: (text: string) => readonly number[],
): void {
  mswServer.use(
    http.post(`${GATEWAY_URL}/embedding-model`, async ({ request }) => {
      const body = (await request.json()) as { values: string[] };
      return HttpResponse.json({
        embeddings: body.values.map(vectorFor),
        usage: { tokens: body.values.length },
      });
    }),
  );
}

/**
 * Answer embedding and reranking calls of the model service. Every text gets
 * the same vector, so only word matches and reranking scores rank results.
 * Returns the reranking requests it received.
 */
export function mockRetrievalModels(
  options: RetrievalModelOptions,
): RerankRequest[] {
  const rerankRequests: RerankRequest[] = [];
  mockEmbeddings(() => [1, 0]);
  mswServer.use(
    http.post(`${GATEWAY_URL}/reranking-model`, async ({ request }) => {
      const body = (await request.json()) as {
        documents: { values: string[] };
        query: string;
      };
      const documents = body.documents.values;
      rerankRequests.push({ documents, query: body.query });
      const scores = documents.map((document) =>
        options.rerank(body.query, document),
      );
      if (scores.some((score) => score === undefined)) {
        // A rejected request, which the client does not retry.
        return HttpResponse.json(
          { error: { message: "invalid request", type: "invalid_request" } },
          { status: 400 },
        );
      }
      return HttpResponse.json({
        ranking: scores.map((score, index) => ({
          index,
          relevanceScore: score,
        })),
      });
    }),
  );
  return rerankRequests;
}
