// TEMP DIAGNOSTIC: remove before review.
import { it } from "vitest";
import { rerankTexts } from "@/chat/pi/client";

const memory =
  "Gut check means reviewing the approach just taken in the thread as a code reviewer. Give the verdict as a reaction on the request: thumbsup to keep it, thumbsdown to redo it. Then name the biggest risk in one sentence. Answer from the thread; do not read files or run commands.";
const queries = [
  "Switch to the other configured profile first. Gut check",
  "Switch to the other configured profile first.",
  "Gut check",
  "gut check",
  "Gut check please",
  "thanks!",
  "how's it going?",
];

it("TEMP rerank probe", async () => {
  const scores: Record<string, number> = {};
  for (const query of queries) {
    const result = await rerankTexts({
      documents: [memory],
      modelId: "voyage/rerank-2.5-lite",
      query,
    });
    scores[query] = result.scores[0]!;
  }
  throw new Error(`RERANK_PROBE ${JSON.stringify(scores)}`);
});
