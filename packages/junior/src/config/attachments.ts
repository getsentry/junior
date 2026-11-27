// The attachment storage group: where attachments and public artifacts live.
import * as z from "zod";
import { toOptionalTrimmed } from "@/chat/optional-string";
import type { Env } from "@/config/fields";

const DEFAULT_S3_REGION = "us-east-1";
const nonEmptyString = z.string().trim().min(1);

const s3StorageSchema = z.strictObject({
  accessKeyId: nonEmptyString,
  bucket: nonEmptyString,
  /** Base URL of the S3 API. Objects use path-style URLs under it. */
  endpoint: nonEmptyString,
  region: nonEmptyString.default(DEFAULT_S3_REGION),
  secretAccessKey: nonEmptyString,
});

/** Object storage for attachments and public artifacts. */
export const attachmentStorageSchema = z.discriminatedUnion("provider", [
  z.strictObject({ provider: z.literal("vercel-blob") }),
  z.strictObject({ provider: z.literal("s3"), s3: s3StorageSchema }),
  z.strictObject({ provider: z.literal("memory") }),
]);

/** Env var that sets each attachment storage field, for error messages. */
export const attachmentStorageEnvNames: Record<string, string> = {
  attachmentStorage: "JUNIOR_ATTACHMENT_STORAGE_PROVIDER",
  "attachmentStorage.s3.accessKeyId": "JUNIOR_S3_ACCESS_KEY_ID",
  "attachmentStorage.s3.bucket": "JUNIOR_S3_BUCKET",
  "attachmentStorage.s3.endpoint": "JUNIOR_S3_ENDPOINT",
  "attachmentStorage.s3.region": "JUNIOR_S3_REGION",
  "attachmentStorage.s3.secretAccessKey": "JUNIOR_S3_SECRET_ACCESS_KEY",
};

function readS3Setting(env: Env, name: string): string {
  const value = toOptionalTrimmed(env[name]);
  if (value === undefined) {
    throw new Error(
      `${name} is required when JUNIOR_ATTACHMENT_STORAGE_PROVIDER is s3`,
    );
  }
  return value;
}

/** Read the attachment storage group from env. */
export function readAttachmentStorage(
  env: Env,
): z.input<typeof attachmentStorageSchema> | undefined {
  const provider = toOptionalTrimmed(env["JUNIOR_ATTACHMENT_STORAGE_PROVIDER"]);
  switch (provider) {
    case undefined:
      return undefined;
    case "vercel-blob":
    case "memory":
      return { provider };
    case "s3":
      return {
        provider,
        s3: {
          accessKeyId: readS3Setting(env, "JUNIOR_S3_ACCESS_KEY_ID"),
          bucket: readS3Setting(env, "JUNIOR_S3_BUCKET"),
          endpoint: readS3Setting(env, "JUNIOR_S3_ENDPOINT"),
          region: toOptionalTrimmed(env["JUNIOR_S3_REGION"]),
          secretAccessKey: readS3Setting(env, "JUNIOR_S3_SECRET_ACCESS_KEY"),
        },
      };
    default:
      throw new Error(
        "JUNIOR_ATTACHMENT_STORAGE_PROVIDER must be vercel-blob, s3, or memory",
      );
  }
}
