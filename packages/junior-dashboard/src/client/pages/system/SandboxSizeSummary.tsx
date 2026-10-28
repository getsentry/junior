import { Cpu } from "lucide-react";

import { Detail, DetailList } from "../../components/DetailList";
import { Card } from "../../components/layout/Card";

/** Vercel Sandbox gives each vCPU 2 GB of memory. */
const MEMORY_GB_PER_VCPU = 2;

/** Format a Sandbox vCPU count with its memory. Null means the Vercel default. */
export function formatSandboxSize(vcpus: number | null): string {
  if (vcpus === null) return "Vercel default";
  return `${vcpus} vCPU${vcpus === 1 ? "" : "s"} · ${vcpus * MEMORY_GB_PER_VCPU} GB`;
}

/** Format the size a Workspace Sandbox uses, and mark when it is the default. */
export function formatWorkspaceSandboxSize(
  vcpus: number | null,
  defaultVcpus: number | null,
): string {
  if (vcpus !== null) return formatSandboxSize(vcpus);
  return defaultVcpus === null
    ? "Vercel default"
    : `Default · ${formatSandboxSize(defaultVcpus)}`;
}

/** Show one Sandbox size in the shared System summary surface. */
export function SandboxSizeSummary(props: {
  description: string;
  headingId: string;
  title: string;
  value: string;
}) {
  return (
    <Card as="section" className="mb-0" padding="md" variant="section">
      <div aria-labelledby={props.headingId} className="grid gap-4">
        <div className="min-w-0 grid gap-1">
          <h2
            className="m-0 text-base font-semibold text-dashboard-text"
            id={props.headingId}
          >
            {props.title}
          </h2>
          <p className="m-0 text-sm leading-relaxed text-dashboard-text-muted">
            {props.description}
          </p>
        </div>
        <DetailList>
          <Detail label="Size">
            <span className="inline-flex items-center gap-2">
              <Cpu aria-hidden="true" size={14} />
              {props.value}
            </span>
          </Detail>
        </DetailList>
      </div>
    </Card>
  );
}
