/**
 * Vercel Blob mock for the agent test fixture.
 *
 * Junior stores conversation attachments, such as files that `sendFiles`
 * delivers, in Vercel Blob. This mock keeps the objects of one test in
 * memory. The eval configs set a fake `BLOB_READ_WRITE_TOKEN`.
 *
 * The Blob SDK sends uploads and deletes with its own `undici` fetch, which
 * MSW does not see. So a local server answers the Blob API, and the mock
 * points the SDK at it with `VERCEL_BLOB_API_URL`. Reads use the global fetch,
 * so an MSW handler answers them.
 */
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { http, HttpResponse } from "msw";
import { mswServer } from "@junior-tests/msw/server";

const BLOB_STORE_URL = /^https:\/\/[^.]+\.private\.blob\.vercel-storage\.com\//;

export interface BlobMock {
  close(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function pathnameOf(url: string): string {
  return url.startsWith("https://")
    ? decodeURIComponent(new URL(url).pathname.slice(1))
    : url;
}

/** Install the Vercel Blob mock for the current test. */
export async function installBlobMock(): Promise<BlobMock> {
  const objects = new Map<string, { body: Buffer; contentType: string }>();

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://blob.test");
    const body = await readBody(request);
    response.setHeader("content-type", "application/json");
    if (request.method === "PUT" && url.pathname === "/") {
      const pathname = url.searchParams.get("pathname") ?? "";
      const contentType =
        (request.headers["x-content-type"] as string | undefined) ??
        "application/octet-stream";
      objects.set(pathname, { body, contentType });
      const blobUrl = `https://evalstore.private.blob.vercel-storage.com/${pathname}`;
      response.end(
        JSON.stringify({
          contentDisposition: "inline",
          contentType,
          downloadUrl: `${blobUrl}?download=1`,
          etag: `"${pathname}"`,
          pathname,
          url: blobUrl,
        }),
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/delete") {
      const { urls } = JSON.parse(body.toString() || "{}") as {
        urls?: string[];
      };
      for (const blobUrl of urls ?? []) objects.delete(pathnameOf(blobUrl));
      response.end("{}");
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: { code: "not_found" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const previousApiUrl = process.env.VERCEL_BLOB_API_URL;
  process.env.VERCEL_BLOB_API_URL = `http://127.0.0.1:${port}`;

  mswServer.use(
    http.get(BLOB_STORE_URL, ({ request }) => {
      const pathname = pathnameOf(request.url.split("?")[0]!);
      const object = objects.get(pathname);
      if (!object) return new HttpResponse(null, { status: 404 });
      return new HttpResponse(new Uint8Array(object.body), {
        headers: {
          "content-length": String(object.body.byteLength),
          "content-type": object.contentType,
          etag: `"${pathname}"`,
          "last-modified": new Date().toUTCString(),
        },
      });
    }),
  );

  return {
    async close() {
      if (previousApiUrl === undefined) {
        delete process.env.VERCEL_BLOB_API_URL;
      } else {
        process.env.VERCEL_BLOB_API_URL = previousApiUrl;
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
