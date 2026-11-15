export type AcpErrorContext = {
  connectionId?: string;
  conversationId?: string;
  userId?: string;
};

export type ReportAcpError = (
  error: unknown,
  event:
    | "acp.transport.exception"
    | "acp.sse.exception"
    | "acp.sse.lock_cleanup.exception",
  context: AcpErrorContext,
) => void;
