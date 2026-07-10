/** Resolve optional resource sizing shared by every newly created sandbox. */
export function getSandboxResources(): { vcpus: number } | undefined {
  const value = process.env.SANDBOX_VCPUS?.trim();
  if (!value || !/^\d+$/.test(value)) {
    return undefined;
  }
  const vcpus = Number(value);
  if (!Number.isSafeInteger(vcpus) || vcpus <= 0) {
    return undefined;
  }
  return { vcpus };
}
