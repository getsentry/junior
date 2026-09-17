import { createGatewayProvider } from "@ai-sdk/gateway-v4";
import {
  experimental_evaluate as evaluate,
  type Experimental_EvaluationQuestion as EvaluationQuestion,
} from "ai-v7";
import { resolveGatewayCredential } from "@/chat/pi/gateway-auth";

/** Evaluate typed questions with an AI Gateway evaluation model. */
export async function evaluateQuestions<
  const Questions extends Record<string, EvaluationQuestion>,
>(args: {
  modelId: string;
  state: string;
  questions: Questions;
  signal?: AbortSignal;
}) {
  const credential = await resolveGatewayCredential();
  const gateway = createGatewayProvider(
    credential ? { apiKey: credential.token } : {},
  );
  return evaluate({
    model: gateway.evaluationModel(args.modelId),
    state: args.state,
    questions: args.questions,
    abortSignal: args.signal,
  });
}
