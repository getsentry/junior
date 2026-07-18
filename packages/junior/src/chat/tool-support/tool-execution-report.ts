export interface ToolExecutionReport {
  error?: string;
  ok: boolean;
  params: Record<string, unknown>;
  result?: unknown;
  toolCallId: string;
  toolName: string;
}
