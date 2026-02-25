import {
  generateObject,
  generateText,
  streamObject,
  streamText
} from "ai";

interface TelemetryOptions {
  functionId?: string;
  metadata?: Record<string, string>;
  recordInputs?: boolean;
  recordOutputs?: boolean;
  isEnabled?: boolean;
}

function mergeTelemetry<T extends { experimental_telemetry?: Record<string, unknown> }>(
  input: T,
  options: TelemetryOptions = {}
): T {
  const existing = input.experimental_telemetry ?? {};
  const existingMetadata =
    typeof existing.metadata === "object" && existing.metadata !== null
      ? (existing.metadata as Record<string, string>)
      : {};

  return {
    ...input,
    experimental_telemetry: {
      isEnabled: true,
      recordInputs: true,
      recordOutputs: true,
      ...options,
      ...existing,
      metadata: {
        ...(options.metadata ?? {}),
        ...existingMetadata
      }
    }
  };
}

export function generateTextWithTelemetry(
  input: Parameters<typeof generateText>[0],
  options: TelemetryOptions = {}
) {
  return generateText(mergeTelemetry(input, options));
}

export function streamTextWithTelemetry(
  input: Parameters<typeof streamText>[0],
  options: TelemetryOptions = {}
) {
  return streamText(mergeTelemetry(input, options));
}

export function generateObjectWithTelemetry(
  input: Parameters<typeof generateObject>[0],
  options: TelemetryOptions = {}
) {
  return generateObject(mergeTelemetry(input, options));
}

export function streamObjectWithTelemetry(
  input: Parameters<typeof streamObject>[0],
  options: TelemetryOptions = {}
) {
  return streamObject(mergeTelemetry(input, options));
}
