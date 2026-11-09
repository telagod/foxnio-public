/** Ask every mounted briefing consumer (card, status panel) for a fresh snapshot. */
export const REFRESH_BRIEFING_EVENT = "foxnio:refresh-briefing";

export function refreshBriefing(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(REFRESH_BRIEFING_EVENT));
  }
}
