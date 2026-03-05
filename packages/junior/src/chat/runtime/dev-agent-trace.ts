export function shouldEmitDevAgentTrace(): boolean {
  return process.env.NODE_ENV === "development";
}
