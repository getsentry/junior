/** Where a stored file came from, such as one Slack file. */
export interface AttachmentSource {
  id: string;
  provider: string;
}

/** A source file that Junior can download now. */
export interface AttachmentSourceFile {
  /** Size that the source reports now. */
  bytes: number;
  /** Open the file. A retried write opens it again. */
  open: () => Promise<ReadableStream<Uint8Array>>;
}

/**
 * Look up a source file that Junior recorded without downloading it.
 *
 * Throw `AttachmentSourceUnavailableError` when the source no longer has the
 * file or Junior cannot read it.
 */
export type ReadAttachmentSource = (
  source: AttachmentSource,
) => Promise<AttachmentSourceFile>;

/** The source deleted the file, or Junior can no longer read it. */
export class AttachmentSourceUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AttachmentSourceUnavailableError";
  }
}
