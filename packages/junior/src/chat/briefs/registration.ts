type BriefsConfig = Readonly<{ enabled?: boolean }>;
type EventEmbeddingsConfig = Readonly<{ enabled?: boolean }>;

let configuredBriefs: BriefsConfig = {};
let configuredEventEmbeddings: EventEmbeddingsConfig = {};

/** Replace app-level Brief settings and return the previous setting. */
export function setBriefsConfig(config?: { enabled?: boolean }): BriefsConfig {
  const previous = { ...configuredBriefs };
  configuredBriefs = config ? { ...config } : {};
  return previous;
}

/** Return whether automatic Brief generation is enabled. */
export function isBriefsEnabled(): boolean {
  return configuredBriefs.enabled === true;
}

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
