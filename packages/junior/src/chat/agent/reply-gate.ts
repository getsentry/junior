import type { PiMessage } from "@/chat/pi/messages";

/**
 * A Run with a reply gate replies only through tools, so its final response
 * reaches nobody. `read` names the task that the Run answers now and says
 * whether the Run replied to it. The Run gets `reminder` once per task when
 * it ends with a final response and has not replied.
 */
export type ReplyGate = {
  read(): Promise<{ replied: boolean; taskId: string }>;
  reminder: string;
};

/** Outcome of the reply gate. Telemetry uses the same names. */
type ReplyGateCheck =
  | { kind: "remind"; messages: PiMessage[]; taskId: string }
  | { kind: "reported" | "missing" };

/**
 * Check a Run at the end of its loop. `remindedTaskId` is Turn state, so a
 * compaction cannot hide it. Returns `remind` with the history and the
 * reminder when the Run ended with a final response, did not reply, and was
 * not reminded for this task. After a reminder, returns `reported` when the
 * Run replied or ended on a terminal tool, and `missing` when it ended with
 * a final response again. Errors, `max_tokens`, and aborts are not gated.
 */
export async function checkReplyGate(args: {
  gate: ReplyGate;
  messages: readonly PiMessage[];
  remindedTaskId: string | undefined;
}): Promise<ReplyGateCheck | undefined> {
  const last = args.messages.at(-1) as
    | { role?: unknown; stopReason?: unknown }
    | undefined;
  const endedWithFinalResponse =
    last?.role === "assistant" && last.stopReason === "stop";
  const endedOnTool = last?.role === "toolResult";
  if (!endedWithFinalResponse && !(endedOnTool && args.remindedTaskId)) {
    return undefined;
  }
  const { replied, taskId } = await args.gate.read();
  if (args.remindedTaskId === taskId) {
    return { kind: replied || endedOnTool ? "reported" : "missing" };
  }
  if (replied || !endedWithFinalResponse) {
    return undefined;
  }
  return {
    kind: "remind",
    messages: [
      ...args.messages,
      {
        role: "user",
        content: [{ type: "text", text: args.gate.reminder }],
        timestamp: Date.now(),
      } as PiMessage,
    ],
    taskId,
  };
}
