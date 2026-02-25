import {
  DEFAULT_MAX_CHARS,
  FETCH_TIMEOUT_MS,
  MAX_FETCH_BYTES,
  MAX_FETCH_CHARS,
  MAX_REDIRECTS
} from "@/chat/tools/constants";
import {
  assertPublicUrl,
  fetchTextWithRedirects,
  readResponseBody,
  withTimeout
} from "@/chat/tools/network";
import { extractContent } from "@/chat/tools/web_fetch/convert";

export { MAX_FETCH_CHARS };

export async function webFetch(url: string, maxChars = DEFAULT_MAX_CHARS): Promise<{ url: string; content: string }> {
  const safeMaxChars = Math.max(500, Math.min(maxChars, MAX_FETCH_CHARS));
  const safeUrl = await assertPublicUrl(url);
  const response = await withTimeout(fetchTextWithRedirects(safeUrl, MAX_REDIRECTS), FETCH_TIMEOUT_MS, "fetch");

  if (!response.ok) {
    throw new Error(`fetch failed: ${response.status}`);
  }

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes("text/") && !contentType.includes("json") && !contentType.includes("xml")) {
    throw new Error(`unsupported content type: ${contentType || "unknown"}`);
  }

  const body = await withTimeout(readResponseBody(response, MAX_FETCH_BYTES), FETCH_TIMEOUT_MS, "read");
  const text = extractContent(body, contentType, safeMaxChars);
  return { url: safeUrl.toString(), content: text };
}
