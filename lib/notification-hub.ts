import type { NotificationEvent } from "./notification-events";
import { markHistoryRead, recordHistory } from "./notification-store";
import type { FoxGoalNotice } from "./fox-goal-notifications";

export type NotificationMessage = { kind: "signal"; event: NotificationEvent }
  | { kind: "goal-notice"; sessionId: string; notice: FoxGoalNotice };
type Send = (message: NotificationMessage) => void;
interface HubState { streams: Map<string, Set<Send>>; }
declare global { var __ompNotificationHub: HubState | undefined; }
function hub(): HubState { return globalThis.__ompNotificationHub ??= { streams: new Map() }; }

export function attachNotificationClient(clientId: string, send: Send): () => void {
  const { streams } = hub();
  const own = streams.get(clientId) ?? new Set<Send>();
  own.add(send);
  streams.set(clientId, own);
  return () => {
    own.delete(send);
    if (own.size === 0 && streams.get(clientId) === own) streams.delete(clientId);
  };
}

export function publishNotification(event: NotificationEvent): void {
  if (event.type === "test") return;
  try {
    recordHistory(event);
    if (event.type === "completed" || event.type === "error") {
      markHistoryRead([event.sessionId, ...(event.aliases ?? [])].map((id) => `${id}:input`));
    }
  } catch (error) {
    console.warn("[fox-signals] history write failed:", error);
  }
  for (const callbacks of hub().streams.values()) {
    for (const send of callbacks) {
      try { send({ kind: "signal", event }); } catch {}
    }
  }
}

/** Dedicated goal alerts never replace raw history signals or input state. */
export function publishFoxGoalNotice(sessionId: string, notice: FoxGoalNotice): boolean {
  let delivered = false;
  for (const callbacks of hub().streams.values()) {
    for (const send of callbacks) {
      try {
        send({ kind: "goal-notice", sessionId, notice });
        delivered = true;
      } catch {}
    }
  }
  return delivered;
}
