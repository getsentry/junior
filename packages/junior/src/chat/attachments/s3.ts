import { AwsClient } from "aws4fetch";
import type { S3StorageConfig } from "./config";
import type { AttachmentStorage } from "./storage";

/** Path-style object URL. Local S3 servers and AWS S3 both accept it. */
function objectUrl(config: S3StorageConfig, key: string): string {
  const endpoint = config.endpoint.replace(/\/+$/, "");
  const path = key.split("/").map(encodeURIComponent).join("/");
  return `${endpoint}/${encodeURIComponent(config.bucket)}/${path}`;
}

/**
 * Read a small S3 response body to the end so the connection is released.
 *
 * Error and empty bodies are small. `body.cancel()` can hang under the test
 * HTTP interceptor, so read the body instead.
 */
async function drain(response: Response): Promise<void> {
  await response.arrayBuffer();
}

/** Throw on a failed S3 response, and release the response body. */
async function expectOk(response: Response, operation: string): Promise<void> {
  await drain(response);
  if (!response.ok) {
    // Do not put the key or the S3 error body in the message. Both can
    // contain user filenames.
    throw new Error(`S3 ${operation} failed with status ${response.status}`);
  }
}

/** Store private conversation attachments in an S3-compatible bucket. */
export function createS3AttachmentStorage(
  config: S3StorageConfig,
): AttachmentStorage {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    region: config.region,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
  });
  return {
    provider: "s3",
    async put(input) {
      const response = await client.fetch(objectUrl(config, input.key), {
        // fetch types reject Buffer. Copy into a plain Uint8Array.
        body: new Uint8Array(input.body),
        headers: { "content-type": input.contentType },
        method: "PUT",
      });
      await expectOk(response, "put");
    },
    async get(key) {
      const response = await client.fetch(objectUrl(config, key));
      if (response.status === 404) {
        await drain(response);
        return null;
      }
      if (!response.ok) {
        await expectOk(response, "get");
      }
      return response.body;
    },
    async delete(keys) {
      await Promise.all(
        keys.map(async (key) => {
          const response = await client.fetch(objectUrl(config, key), {
            method: "DELETE",
          });
          // S3 returns 204 for a missing key. Some local servers return 404.
          if (response.status === 404) {
            await drain(response);
            return;
          }
          await expectOk(response, "delete");
        }),
      );
    },
  };
}
