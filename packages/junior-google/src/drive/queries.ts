/** Quote a value for a Drive search query. */
export function driveQueryString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** Drive search terms for files that name the requester in a permission. */
export function namedQuery(requester: string): string {
  const email = driveQueryString(requester);
  return `(${email} in readers or ${email} in writers or ${email} in owners)`;
}
