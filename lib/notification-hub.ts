import type { NotificationEvent } from "./notification-events";
import { markHistoryRead, recordHistory } from "./notification-history-store";
import type { FoxGoalNotice } from "./fox-goal-notifications";

export type NotificationMessage = { kind: "signal"; event: NotificationEvent }
  | { kind: "goal-notice"; sessionId: string; notice: FoxGoalNotice };
type Send = (message: NotificationMessage) => void;
interface PendingWrite { run: () => Promise<void>; resolve: () => void; reject: (error: unknown) => void; }
interface HubState {
  streams: Map<string, Set<Send>>;
  pending: PendingWrite[];
  writing: boolean;
  failure: string | null;
  drains: Array<() => void>;
}
declare global { var __ompNotificationHub: HubState | undefined; }
function hub(): HubState {
  return globalThis.__ompNotificationHub ??= { streams: new Map(), pending: [], writing: false, failure: null, drains: [] };
}
const MAX_PENDING_WRITES = 256;

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

function broadcast(message: NotificationMessage): boolean {
  let delivered = false;
  for (const callbacks of hub().streams.values()) {
    for (const send of callbacks) {
      try { send(message); delivered = true; } catch {}
    }
  }
  return delivered;
}

function pump(): void {
  const state = hub();
  if (state.writing) return;
  const work = state.pending.shift();
  if (!work) { for (const done of state.drains.splice(0)) done(); return; }
  state.writing = true;
  void work.run().then(() => {
    state.failure = null;
    work.resolve();
  }, (error) => {
    state.failure = error instanceof Error ? error.message : String(error);
    work.reject(error);
  }).finally(() => { state.writing = false; pump(); });
}

function enqueue(run: () => Promise<void>): Promise<void> {
  const state = hub();
  if (state.pending.length >= MAX_PENDING_WRITES) {
    state.failure = "Notification persistence queue is full; uncommitted signals were not published";
    return Promise.reject(Object.assign(new Error(state.failure), { code: "storage_busy" }));
  }
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  state.pending.push({ run, resolve, reject });
  pump();
  return promise;
}

/** Ordered write-behind is confined to this synchronous RPC-frame boundary.
 * Tokens/tools remain live; durable signals fan out only after COMMIT. */
export function publishNotification(event: NotificationEvent): Promise<void> {
  if (event.type === "test") return Promise.resolve();
  const operation = enqueue(async () => {
    const settleInputIds = event.type === "completed" || event.type === "error"
      ? [event.sessionId, ...(event.aliases ?? [])].map((id) => `${id}:input`) : [];
    await recordHistory(event, { settleInputIds });
    broadcast({ kind: "signal", event });
  });
  // Frame listeners intentionally do not await, but every rejection is owned.
  void operation.catch((error) => console.warn("[fox-signals] history write failed:", error));
  return operation;
}

/** Input settlement follows earlier queued input signals instead of racing them. */
export function settleNotificationInputs(ids: string[]): Promise<void> {
  const operation = enqueue(() => markHistoryRead(ids));
  void operation.catch((error) => console.warn("[fox-signals] input settlement failed:", error));
  return operation;
}

export function notificationPersistenceError(): string | null { return hub().failure; }

export async function drainNotificationWrites(timeoutMs = 5000): Promise<void> {
  const state = hub();
  if (!state.writing && state.pending.length === 0) return;
  const completed = Promise.withResolvers<void>();
  const expired = Promise.withResolvers<never>();
  state.drains.push(completed.resolve);
  const timer = setTimeout(() => expired.reject(new Error("Notification persistence drain timed out")), timeoutMs);
  try {
    await Promise.race([completed.promise, expired.promise]);
  } finally {
    clearTimeout(timer);
    state.drains = state.drains.filter((item) => item !== completed.resolve);
  }
}

/** Dedicated goal alerts never replace raw history signals or input state. */
export function publishFoxGoalNotice(sessionId: string, notice: FoxGoalNotice): boolean {
  return broadcast({ kind: "goal-notice", sessionId, notice });
}
