"use strict";

// Only these schemes may leave the app for the operating system's default handler.
// Anything else (file:, ms-msdt:, smb:, custom app protocols ...) can run code or
// leak credentials when handed to shell.openExternal.
const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/**
 * Decide what a navigation or window.open target may do.
 * - "internal": same origin as the local server, stays in the Electron window.
 * - "external": safe to open in the default browser or mail client.
 * - "deny": unparseable or an unsafe scheme; do nothing.
 */
function classifyNavigation(rawUrl, allowedOrigin) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return "deny";
  }
  if (url.origin === allowedOrigin) return "internal";
  return EXTERNAL_PROTOCOLS.has(url.protocol) ? "external" : "deny";
}

module.exports = { classifyNavigation };
