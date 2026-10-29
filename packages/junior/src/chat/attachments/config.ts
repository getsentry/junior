import { toOptionalTrimmed } from "@/chat/optional-string";
import { readS3StorageConfig, type S3StorageConfig } from "./s3";

/** Object storage for attachments and public artifacts. */
export type AttachmentStorageConfig =
  | { provider: "vercel-blob" }
  | { provider: "s3"; s3: S3StorageConfig };

/** Read attachment storage settings from environment variables. */
export function readAttachmentStorageConfig(
  env: NodeJS.ProcessEnv,
): AttachmentStorageConfig {
  const provider =
    toOptionalTrimmed(env.JUNIOR_ATTACHMENT_STORAGE_PROVIDER) ?? "vercel-blob";
  switch (provider) {
    case "vercel-blob":
      return { provider };
    case "s3":
      return { provider, s3: readS3StorageConfig(env) };
    default:
      throw new Error(
        "JUNIOR_ATTACHMENT_STORAGE_PROVIDER must be vercel-blob or s3",
      );
  }
}
