import type {
  TranscriptMessage,
  TranscriptPart,
  TranscriptRole,
} from "@sentry/junior/api/schema";

export type MockTextPartOptions = {
  bytes?: number;
  chars?: number;
  redacted?: boolean;
  sourceType?: string;
  text?: string;
};

/** Build a transcript text part constrained to the reporting API shape. */
export function mockTextPart(
  options: MockTextPartOptions = {},
): TranscriptPart {
  return {
    type: "text",
    text: options.text ?? "Mock transcript text",
    ...(options.bytes !== undefined ? { bytes: options.bytes } : {}),
    ...(options.chars !== undefined ? { chars: options.chars } : {}),
    ...(options.redacted !== undefined ? { redacted: options.redacted } : {}),
    ...(options.sourceType !== undefined
      ? { sourceType: options.sourceType }
      : {}),
  } satisfies TranscriptPart;
}

export type MockThinkingPartOptions = {
  output?: unknown;
  outputKeys?: string[];
  outputSizeBytes?: number;
  outputSizeChars?: number;
  outputType?: string;
  redacted?: boolean;
};

/** Build a transcript thinking part constrained to the reporting API shape. */
export function mockThinkingPart(
  options: MockThinkingPartOptions = {},
): TranscriptPart {
  return {
    type: "thinking",
    output: options.output ?? "Inspect the mock reporting state.",
    ...(options.outputKeys !== undefined
      ? { outputKeys: options.outputKeys }
      : {}),
    ...(options.outputSizeBytes !== undefined
      ? { outputSizeBytes: options.outputSizeBytes }
      : {}),
    ...(options.outputSizeChars !== undefined
      ? { outputSizeChars: options.outputSizeChars }
      : {}),
    ...(options.outputType !== undefined
      ? { outputType: options.outputType }
      : {}),
    ...(options.redacted !== undefined ? { redacted: options.redacted } : {}),
  } satisfies TranscriptPart;
}

export type MockToolCallPartOptions = {
  id?: string;
  input?: unknown;
  inputKeys?: string[];
  inputSizeBytes?: number;
  inputSizeChars?: number;
  inputType?: string;
  name?: string;
  redacted?: boolean;
};

/** Build a transcript tool-call part constrained to the reporting API shape. */
export function mockToolCallPart(
  options: MockToolCallPartOptions = {},
): TranscriptPart {
  return {
    type: "tool_call",
    id: options.id ?? "toolu_mock_call",
    name: options.name ?? "mock.tool",
    ...(options.input !== undefined ? { input: options.input } : {}),
    ...(options.inputKeys !== undefined
      ? { inputKeys: options.inputKeys }
      : {}),
    ...(options.inputSizeBytes !== undefined
      ? { inputSizeBytes: options.inputSizeBytes }
      : {}),
    ...(options.inputSizeChars !== undefined
      ? { inputSizeChars: options.inputSizeChars }
      : {}),
    ...(options.inputType !== undefined
      ? { inputType: options.inputType }
      : {}),
    ...(options.redacted !== undefined ? { redacted: options.redacted } : {}),
  } satisfies TranscriptPart;
}

export type MockToolResultPartOptions = {
  id?: string;
  name?: string;
  output?: unknown;
  outputKeys?: string[];
  outputSizeBytes?: number;
  outputSizeChars?: number;
  outputType?: string;
  redacted?: boolean;
};

/** Build a transcript tool-result part constrained to the reporting API shape. */
export function mockToolResultPart(
  options: MockToolResultPartOptions = {},
): TranscriptPart {
  return {
    type: "tool_result",
    id: options.id ?? "toolu_mock_call",
    name: options.name ?? "mock.tool",
    ...(options.output !== undefined ? { output: options.output } : {}),
    ...(options.outputKeys !== undefined
      ? { outputKeys: options.outputKeys }
      : {}),
    ...(options.outputSizeBytes !== undefined
      ? { outputSizeBytes: options.outputSizeBytes }
      : {}),
    ...(options.outputSizeChars !== undefined
      ? { outputSizeChars: options.outputSizeChars }
      : {}),
    ...(options.outputType !== undefined
      ? { outputType: options.outputType }
      : {}),
    ...(options.redacted !== undefined ? { redacted: options.redacted } : {}),
  } satisfies TranscriptPart;
}

export type MockTranscriptMessageOptions = {
  parts?: TranscriptPart[];
  role?: TranscriptRole;
  timestamp?: number;
};

/** Build a transcript message constrained to the reporting API shape. */
export function mockTranscriptMessage(
  options: MockTranscriptMessageOptions = {},
): TranscriptMessage {
  return {
    role: options.role ?? "assistant",
    parts: options.parts ?? [mockTextPart()],
    ...(options.timestamp !== undefined
      ? { timestamp: options.timestamp }
      : {}),
  } satisfies TranscriptMessage;
}
