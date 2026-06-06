/** Detect whether the user explicitly asked the assistant to post a message in the channel (not the thread). */
export function isExplicitChannelPostIntent(text: string): boolean {
  if (!/\bchannel\b/i.test(text)) {
    return false;
  }

  const directChannelVerb =
    /\b(show|post|send|share|say|announce|broadcast)\b[\s\S]{0,80}\b(?:the\s+)?channel\b/i;
  if (directChannelVerb.test(text)) {
    return true;
  }

  const scopedChannelVerb =
    /\b(post|send|share|say|announce|broadcast)\b[\s\S]{0,80}\b(?:in|to)\b[\s\S]{0,40}\b(?:the\s+)?channel\b/i;
  return scopedChannelVerb.test(text);
}
