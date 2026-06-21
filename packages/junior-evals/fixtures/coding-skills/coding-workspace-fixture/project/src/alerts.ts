type AlertMode = "normal" | "emergency";

export function alertChannelFor(mode: AlertMode): string {
  if (mode === "emergency") {
    return "#ops-critical";
  }

  return "#ops-notices";
}

export function formatAlert(mode: AlertMode, message: string): string {
  const prefix = mode === "emergency" ? "[EMERGENCY]" : "[notice]";
  return `${prefix} ${message}`;
}
