import { useEffect, useRef } from "react";
import { openResilientEventStream } from "@/lib/event-stream";
import type { NotificationEvent } from "@/lib/notification-events";
import { notificationHistory } from "@/lib/notification-history";
import { notificationClientId, OPEN_SESSION_EVENT } from "@/lib/notification-client";
import { isRecord } from "@/lib/type-guards";
import { toast } from "@/components/ui/toast";

export function useSessionSignals({ sessionId, onOpenSession }: { sessionId: string | null; onOpenSession: (sessionId: string) => void }) {
  const openRef = useRef(onOpenSession);
  const seenGoalNotices = useRef(new Set<string>());
  useEffect(() => { openRef.current = onOpenSession; }, [onOpenSession]);
  useEffect(() => {
    const visible = () => { if (document.visibilityState === "visible") void notificationHistory.load(); };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, []);
  useEffect(() => { if (sessionId) notificationHistory.markSessionInputRead(sessionId); }, [sessionId]);
  useEffect(() => {
    const onOpen = (raw: Event) => {
      if (raw instanceof CustomEvent && typeof raw.detail === "string" && raw.detail) openRef.current(raw.detail);
    };
    const onWorkerMessage = (message: MessageEvent) => {
      const data: unknown = message.data;
      if (isRecord(data) && data.type === "omp-open-session" && typeof data.sessionId === "string" && data.sessionId) {
        window.dispatchEvent(new CustomEvent(OPEN_SESSION_EVENT, { detail: data.sessionId }));
      }
    };
    const stop = openResilientEventStream({ kind: "notifications", clientId: notificationClientId }, (data) => {
      try {
        const frame: unknown = JSON.parse(data);
        if (!isRecord(frame) || frame.type !== "notification") return;
        if (frame.kind === "goal-notice" && typeof frame.sessionId === "string" && isRecord(frame.notice)) {
          const notice = frame.notice;
          if (typeof notice.key !== "string" || typeof notice.title !== "string" || typeof notice.detail !== "string"
            || !["completed", "input", "error"].includes(String(notice.kind)) || seenGoalNotices.current.has(notice.key)) return;
          seenGoalNotices.current.add(notice.key);
          if (seenGoalNotices.current.size > 200) seenGoalNotices.current.delete(seenGoalNotices.current.values().next().value!);
          const ownerSessionId = frame.sessionId;
          toast.info(notice.title, notice.detail, {
            id: notice.key,
            onClick: () => { openRef.current(ownerSessionId); },
          });
        } else if (frame.kind === "signal" && isRecord(frame.event)) {
          notificationHistory.add(frame.event as unknown as NotificationEvent);
        }
      } catch {}
    }, {
      // OPEN means the subscription is installed, including after reconnect.
      // load() fences snapshots against signals arriving while it is in flight.
      onOpen: () => { void notificationHistory.load(); },
    });
    window.addEventListener(OPEN_SESSION_EVENT, onOpen);
    navigator.serviceWorker?.addEventListener("message", onWorkerMessage);
    void navigator.serviceWorker?.getRegistration().then(async (registration) => {
      const script = registration?.active?.scriptURL ?? registration?.waiting?.scriptURL ?? registration?.installing?.scriptURL;
      if (!registration || !script || new URL(script).pathname !== "/sw.js") return;
      await registration.update().catch(() => {});
      const subscription = await registration.pushManager.getSubscription();
      await subscription?.unsubscribe();
      const shown = await registration.getNotifications();
      for (const notification of shown) notification.close();
    }).catch(() => {});
    return () => {
      stop();
      window.removeEventListener(OPEN_SESSION_EVENT, onOpen);
      navigator.serviceWorker?.removeEventListener("message", onWorkerMessage);
    };
  }, []);
}
