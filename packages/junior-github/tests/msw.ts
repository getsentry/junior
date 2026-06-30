import { setupServer } from "msw/node";

export const mswServer = setupServer();

export function rejectUnhandledExternalRequest(request: Request): void {
  const url = new URL(request.url);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
    return;
  }

  throw new Error(
    `[HTTP MOCK] Unhandled external request: ${request.method} ${request.url}`,
  );
}
