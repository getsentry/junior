type EventEmbeddingsConfig = Readonly<{ enabled?: boolean }>;

let configuredEventEmbeddings: EventEmbeddingsConfig = {};

/** Replace app-level event embedding settings and return the previous setting. */
export function setEventEmbeddingsConfig(config?: {
  enabled?: boolean;
}): EventEmbeddingsConfig {
  const previous = { ...configuredEventEmbeddings };
  configuredEventEmbeddings = config ? { ...config } : {};
  return previous;
}

/** Return whether event embeddings and meaning search are enabled. */
export function isEventEmbeddingsEnabled(): boolean {
  return configuredEventEmbeddings.enabled === true;
}
