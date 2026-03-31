/** Build a simple centered HTML callback page. Callers must pre-escape dynamic strings. */
export function htmlCallbackResponse(
  title: string,
  message: string,
  status: number,
): Response {
  const html = `<!DOCTYPE html>
<html>
<head><title>${title}</title></head>
<body style="font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0;">
  <div style="text-align: center; max-width: 480px;">
    <h1>${title}</h1>
    <p>${message}</p>
    <p style="margin-top: 2rem; color: #666; font-size: 0.9em;">You can close this tab and return to Slack.</p>
  </div>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
