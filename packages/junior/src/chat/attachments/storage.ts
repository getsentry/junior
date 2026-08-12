/** Bytes and metadata written to attachment object storage. */
export interface AttachmentWrite {
  body: Buffer;
  contentType: string;
  key: string;
}

/** Small object-storage capability used by conversation attachments. */
export interface AttachmentStorage {
  readonly provider: string;
  put(input: AttachmentWrite): Promise<void>;
  delete(keys: string[]): Promise<void>;
}
