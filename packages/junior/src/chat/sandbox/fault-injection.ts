const STREAM_INTERRUPT_FAULT_ENV =
  "JUNIOR_EVAL_FAULT_SANDBOX_BASH_STREAM_INTERRUPTS";

/** Consume one eval-only sandbox bash stream interruption fault. */
export function consumeSandboxBashStreamInterruptFault(): Error | undefined {
  if (process.env.JUNIOR_EVAL_ENABLE_FAULTS !== "1") {
    return undefined;
  }

  const remaining = Number.parseInt(
    process.env[STREAM_INTERRUPT_FAULT_ENV] ?? "0",
    10,
  );
  if (!Number.isFinite(remaining) || remaining <= 0) {
    return undefined;
  }

  process.env[STREAM_INTERRUPT_FAULT_ENV] = String(remaining - 1);
  return Object.assign(new Error("Stream ended before command finished"), {
    name: "StreamError",
  });
}
