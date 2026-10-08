import { APICallError } from "ai-batch";
import {
  observationBatchResults,
  observationBatchStatus,
  submitObservationBatch,
} from "@/chat/distillation/batch";

const sha = process.env.GITHUB_SHA;
if (!sha || !/^[a-f0-9]{40}$/.test(sha)) {
  throw new Error("A GitHub commit SHA is required for the Batch probe");
}

try {
  const batch = await submitObservationBatch({
    conversationId: `ci-batch-probe:${sha}`,
    historyVersion: 0,
    requests: [
      {
        id: "synthetic-observation",
        system:
          "Return one short fact inside <observations> and </observations>. Do not use outside data.",
        prompt: "The test object is blue. Record its color.",
      },
    ],
  });
  const status = await observationBatchStatus(batch);
  if (status !== "completed") {
    console.log(JSON.stringify({ status }));
    if (status === "failed") process.exitCode = 1;
  } else {
    const results = await observationBatchResults(batch, 1);
    const result = results[0];
    console.log(
      JSON.stringify({
        status,
        resultCount: results.length,
        succeeded:
          result?.status === "succeeded" &&
          result.text?.includes("<observations>") &&
          result.text?.includes("</observations>"),
        costUsd: result?.costUsd,
        costEstimated: result?.costEstimated ?? false,
      }),
    );
    if (
      result?.status !== "succeeded" ||
      !result.text?.includes("<observations>") ||
      !result.text?.includes("</observations>")
    ) {
      process.exitCode = 1;
    }
  }
} catch (error) {
  // Never print provider responses, batch references, prompts, or tokens.
  console.log(
    JSON.stringify({
      status: "error",
      httpStatus: APICallError.isInstance(error) ? error.statusCode : undefined,
    }),
  );
  process.exitCode = 1;
}
