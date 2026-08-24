export interface AcpErrorContext {
  connectionId?: string;
  conversationId?: string;
  userId?: string;
}

export type ReportAcpError = (
  error: unknown,
  event: string,
  context: AcpErrorContext,
) => void;
