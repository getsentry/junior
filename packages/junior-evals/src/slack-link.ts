/** Parse the URL target from Slack mrkdwn link text. */
export function parseSlackMrkdwnLinkUrl(text: string): URL | undefined {
  const match = text.match(/<([^|>]+)\|/);
  if (!match?.[1]) {
    return undefined;
  }
  try {
    return new URL(match[1].replaceAll("&amp;", "&"));
  } catch {
    return undefined;
  }
}
