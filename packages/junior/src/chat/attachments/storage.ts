/** Bytes and metadata written to attachment object storage. */
export interface AttachmentWrite {
  body: Buffer;
  contentType: string;
  key: string;
}

/** Bytes read back from attachment object storage. */
export interface AttachmentContent {
  body: ReadableStream<Uint8Array>;
  contentType: string;
}

/** Small object-storage capability used by conversation attachments. */
export interface AttachmentStorage {
  readonly provider: string;
  put(input: AttachmentWrite): Promise<void>;
  /** Return live object bytes, or null when the key is missing. */
  get(key: string): Promise<AttachmentContent | null>;
  delete(keys: string[]): Promise<void>;
}
