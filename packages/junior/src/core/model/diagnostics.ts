// What core reports about how it built one model request: how each loader
// ran and what happened to each fragment. It holds no content, so it is safe
// to log and to store.
import type { LoaderLifetime } from "@/core/model/request";

/** How one loader ran for a model request. */
export type LoaderDiagnostics = {
  label: string;
  lifetime: LoaderLifetime;
  /** How long the request waited for the value. */
  ms: number;
  /** `cached`: a `deployment` value from an earlier request. */
  status: "ok" | "cached" | "failed" | "timed_out";
};

/** What happened to one fragment of a model request. */
export type FragmentDiagnostics = {
  name: string;
  field: "systemPrompt" | "tools" | "messages" | "model";
  /** `skipped`: `format` returned `skip`. `disabled`: `enabled` returned false. */
  status: "included" | "skipped" | "disabled";
  /** The reason that `skip` gave. */
  reason?: string;
};

/** How core built one model request. Loaders and fragments are in layout order. */
export type ModelRequestDiagnostics = {
  loaders: LoaderDiagnostics[];
  fragments: FragmentDiagnostics[];
};
