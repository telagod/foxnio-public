/** URL that opens a saved session in the app; the same `?session=` form AppShell restores from. */
export function sessionHref(sessionId: string): string {
  return `/?session=${encodeURIComponent(sessionId)}`;
}
