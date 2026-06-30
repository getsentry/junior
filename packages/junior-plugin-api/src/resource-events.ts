export interface SubscribableResource {
  defaultTtlMs?: number;
  label: string;
  provider: string;
  ref: string;
  suggestedEvents?: string[];
  supportedEvents: string[];
  type: string;
}
