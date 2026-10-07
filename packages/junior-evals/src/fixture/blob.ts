/**
 * Vercel Blob mock for the agent test fixture.
 *
 * Junior stores conversation attachments, such as files that `sendFiles`
 * delivers, in Vercel Blob. This mock keeps the objects of one test in
 * memory. The eval configs set a fake `BLOB_READ_WRITE_TOKEN`.
 *
 * The Blob SDK sends every request with its own `undici` fetch, which MSW
 * does not see. So a local server answers the SDK. The mock points uploads
 * and deletes at it with `VERCEL_BLOB_API_URL`. Reads go to the URL of the
 * store, which no setting changes, so an `undici` interceptor sends them to
 * the local server.
 */
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";

const BLOB_STORE_ORIGIN =
  /^https:\/\/[^.]+\.private\.blob\.vercel-storage\.com$/;

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

/** Whether a request goes to a private Vercel Blob store. */
function isBlobStore(origin: string | URL | undefined): boolean {
  return origin
    ? BLOB_STORE_ORIGIN.test(new URL(String(origin)).origin)
    : false;
}

/** Install the Vercel Blob mock for the current test. */
export async function installBlobMock(): Promise<BlobMock> {
  const objects = new Map<string, { body: Buffer; contentType: string }>();

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://blob.test");
    const body = await readBody(request);
    if (request.method === "GET") {
      const pathname = decodeURIComponent(url.pathname.slice(1));
      const object = objects.get(pathname);
      if (!object) {
        response.statusCode = 404;
        response.end();
        return;
      }
      response.setHeader("content-type", object.contentType);
      response.setHeader("etag", `"${pathname}"`);
      response.setHeader("last-modified", new Date().toUTCString());
      response.end(object.body);
      return;
    }
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
  const localOrigin = `http://127.0.0.1:${port}`;
  const previousApiUrl = process.env.VERCEL_BLOB_API_URL;
  process.env.VERCEL_BLOB_API_URL = localOrigin;
  const previousDispatcher = getGlobalDispatcher();
  setGlobalDispatcher(
    previousDispatcher.compose(
      (dispatch) => (options, handler) =>
        dispatch(
          isBlobStore(options.origin)
            ? { ...options, origin: localOrigin }
            : options,
          handler,
        ),
    ),
  );

  return {
    async close() {
      setGlobalDispatcher(previousDispatcher);
      if (previousApiUrl === undefined) {
        delete process.env.VERCEL_BLOB_API_URL;
      } else {
        process.env.VERCEL_BLOB_API_URL = previousApiUrl;
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
