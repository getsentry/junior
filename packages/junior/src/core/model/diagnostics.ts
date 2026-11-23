// What core reports about how it built one model request: the size of each
// system prompt part, how each loader ran and what happened to each fragment.
// It holds no content, so it is safe to log and to store.

/** One system prompt part of a model request. */
type SystemPromptPartDiagnostics = {
  name: string;
  /** The length of the part's text. */
  chars: number;
};

/** How one loader ran for a model request. */
export type LoaderDiagnostics = {
  label: string;
  /** How long the request waited for the value. */
  ms: number;
  status: "ok" | "failed" | "timed_out";
};

/** What happened to one fragment of a model request. */
export type FragmentDiagnostics = {
  name: string;
  field: "messages" | "model";
  /** `skipped`: `format` returned `skip`. `disabled`: `enabled` returned false. */
  status: "included" | "skipped" | "disabled";
  /** The reason that `skip` gave. */
  reason?: string;
};

/** How core built one model request. Each list is in layout order. */
export type ModelRequestDiagnostics = {
  systemPrompt: SystemPromptPartDiagnostics[];
  loaders: LoaderDiagnostics[];
  fragments: FragmentDiagnostics[];
};
