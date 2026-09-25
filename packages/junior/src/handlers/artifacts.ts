import { createVercelAttachmentStorage } from "@/chat/attachments/vercel";
import type { AttachmentStorage } from "@/chat/attachments/storage";
import {
  publicArtifactHeaders,
  readPublicArtifact,
  unpublishedArtifactHeaders,
} from "@/chat/artifacts/store";
import { getSqlExecutor } from "@/chat/db";
import { logException } from "@/chat/logging";
import type { JuniorSqlDatabase } from "@/db/db";

/** Serve one content-addressed public artifact without authentication. */
export async function publicArtifactGET(args: {
  db?: JuniorSqlDatabase;
  filename: string;
  storage?: Pick<AttachmentStorage, "get">;
}): Promise<Response> {
  try {
    const artifact = await readPublicArtifact({
      db: args.db ?? getSqlExecutor(),
      filename: args.filename,
      storage: args.storage ?? createVercelAttachmentStorage(),
    });
    if (!artifact) {
      return new Response("Not Found", {
        headers: unpublishedArtifactHeaders(),
        status: 404,
      });
    }

    return new Response(artifact.body, {
      headers: publicArtifactHeaders(artifact.contentType),
    });
  } catch (error) {
    logException(error, "public_artifact.get.failed");
    return new Response("Internal Server Error", { status: 500 });
  }
}
