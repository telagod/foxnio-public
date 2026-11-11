import { createHash } from "node:crypto";

export const FOX_DISPATCH_RECEIPT_PREFIX = "foxnio:native-dispatch:";

export function foxActionFingerprint(action) {
  const value = [action.sessionId, action.toolCallId, action.toolName, action.input, action.projectKey];
  const canonical = JSON.stringify(value, (_key, item) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
    }
    return item;
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export class FoxDispatchReceipts {
  #receipts = new Map();
  #now;
  #maxAgeMs;

  constructor({ now = Date.now, maxAgeMs = 60_000 } = {}) {
    this.#now = now;
    this.#maxAgeMs = maxAgeMs;
  }

  capture(frame) {
    if (frame.type !== "extension_ui_request" || frame.method !== "notify"
      || typeof frame.message !== "string" || !frame.message.startsWith(FOX_DISPATCH_RECEIPT_PREFIX)) return false;
    try {
      const receipt = JSON.parse(frame.message.slice(FOX_DISPATCH_RECEIPT_PREFIX.length));
      if (!receipt || typeof receipt !== "object"
        || typeof receipt.sessionId !== "string" || !receipt.sessionId || receipt.sessionId.length > 200
        || typeof receipt.toolCallId !== "string" || !receipt.toolCallId || receipt.toolCallId.length > 200
        || !["new_session", "send_to_session"].includes(receipt.toolName)
        || typeof receipt.projectKey !== "string" || !receipt.projectKey || receipt.projectKey.length > 4096
        || !["confirmed", "automatic", "grant"].includes(receipt.confirmation)
        || receipt.confirmation === "grant" && [receipt.grantEntryId, receipt.admissionId, receipt.nativeGoalId].some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(id))
        || typeof receipt.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(receipt.fingerprint)) return true;
      if (this.#receipts.size >= 64) this.#receipts.delete(this.#receipts.keys().next().value);
      this.#receipts.set(receipt.toolCallId, { ...receipt, receivedAt: this.#now() });
    } catch {
      return true;
    }
    return true;
  }

  take(action, requireConfirmation) {
    const receipt = this.#receipts.get(action.toolCallId);
    this.#receipts.delete(action.toolCallId);
    if (!receipt) return false;
    if (receipt.confirmation === "grant") return false;
    const age = this.#now() - receipt.receivedAt;
    return age >= 0 && age <= this.#maxAgeMs
      && receipt.sessionId === action.sessionId
      && receipt.toolName === action.toolName
      && (!requireConfirmation || receipt.confirmation === "confirmed")
      && receipt.fingerprint === foxActionFingerprint(action);
  }

  takeGrant(action) {
    const receipt = this.#receipts.get(action.toolCallId);
    this.#receipts.delete(action.toolCallId);
    if (!receipt || receipt.confirmation !== "grant") return null;
    const age = this.#now() - receipt.receivedAt;
    return age >= 0 && age <= this.#maxAgeMs && receipt.sessionId === action.sessionId
      && receipt.toolName === action.toolName && receipt.projectKey === action.projectKey
      && receipt.fingerprint === foxActionFingerprint(action) ? receipt : null;
  }

  clear() {
    this.#receipts.clear();
  }
}
