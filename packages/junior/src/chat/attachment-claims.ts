function splitSentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function sentenceClaimsAttachment(sentence: string): boolean {
  const hasAttachmentNoun = /\b(screenshot|image|file|attachment)\b/i.test(
    sentence,
  );
  if (!hasAttachmentNoun) {
    return false;
  }

  const hasPositiveAttachmentVerb =
    /\b(attached|shared|uploaded|included)\b/i.test(sentence);
  const hasDeicticSharePhrase = /\bhere(?:'s| is)\b/i.test(sentence);
  return hasPositiveAttachmentVerb || hasDeicticSharePhrase;
}

function claimsAttachment(text: string): boolean {
  return splitSentences(text).some((sentence) =>
    sentenceClaimsAttachment(sentence),
  );
}

export function enforceAttachmentClaimTruth(
  text: string,
  hasAttachedFiles: boolean,
): string {
  if (hasAttachedFiles || !claimsAttachment(text)) {
    return text;
  }

  return `${text}\n\nNote: No file was attached in this turn. I need to run \`attachFile\` before claiming the screenshot is shared.`;
}
