/**
 * Window event used by the FOX status panel to seed the resident chat's
 * composer. The panel and the chat are siblings in the shell, so the prompt
 * travels as an event rather than through the whole AppShell prop chain.
 */
export const FOX_ASK_EVENT = "foxnio:fox-ask";

export interface FoxAskDetail {
  prompt: string;
}

export function askFox(prompt: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<FoxAskDetail>(FOX_ASK_EVENT, { detail: { prompt } }));
}
