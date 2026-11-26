import { Check, CircleAlert, Hand, LoaderCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { LeadWorkState } from "./leadWork";

/** Icon and text color of each Lead state. */
export const leadWorkStatus: Record<
  LeadWorkState,
  { icon: LucideIcon; text: string }
> = {
  done: { icon: Check, text: "text-zinc-400" },
  failed: { icon: CircleAlert, text: "text-red-400" },
  needs_you: { icon: Hand, text: "text-amber-400" },
  working: { icon: LoaderCircle, text: "text-cyan-400" },
};
