/** Vercel Sandbox gives each vCPU 2 GB of memory. */
const MEMORY_GB_PER_VCPU = 2;

/** Format a Sandbox vCPU count with its memory. Null means the Vercel default. */
export function formatSandboxSize(vcpus: number | null): string {
  if (vcpus === null) return "Vercel default";
  return `${vcpus} vCPU${vcpus === 1 ? "" : "s"} · ${vcpus * MEMORY_GB_PER_VCPU} GB`;
}
