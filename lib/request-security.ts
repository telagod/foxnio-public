import { isLoopbackHost } from "../bin/network-addresses.js";

function canonicalOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function getRequestOrigin(request: Request): string | null {
  const requestUrl = new URL(request.url);
  const host = request.headers.get("host");
  return host ? canonicalOrigin(`${requestUrl.protocol}//${host}`) : requestUrl.origin;
}

/** Reject browser cross-site API requests while preserving non-browser clients. */
export function isApiRequestOriginAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (!origin) return fetchSite !== "cross-site";

  const requestOrigin = getRequestOrigin(request);
  if (requestOrigin === null) return false;
  if (canonicalOrigin(origin) === requestOrigin) return true;
  // Some local HTTP proxies strip the port from the forwarded Origin header
  // (e.g. `http://127.0.0.1:30177` arrives as `http://127.0.0.1`), which
  // would otherwise 403 every API request (issue #114). Accept that shape
  // only when protocol + hostname match exactly and the received Origin
  // carries the scheme's default port (i.e. no explicit port — browsers
  // always send a non-default port, so a same-host attacker on another
  // explicit port such as :9999 is still rejected). Hostname mismatches
  // (the evil.com drive-by case) are still rejected here.
  try {
    const received = new URL(origin);
    const expected = new URL(requestOrigin);
    return received.protocol === expected.protocol
      && received.hostname === expected.hostname
      && received.port === "";
  } catch {
    return false;
  }
}

export function shouldCheckApiRequestOrigin(request: Request): boolean {
  return request.headers.has("origin") || request.headers.has("sec-fetch-site");
}

/** Extra hostnames accepted when no web password protects the server. */
export const ALLOWED_HOSTS_VAR = "OMP_WEB_ALLOWED_HOSTS";

const HOSTNAME_PATTERN = /^[a-z0-9_]([a-z0-9_.-]*[a-z0-9_])?$/;

/**
 * Hostname of a `Host` header value (or an allow-list entry), lowercased, with
 * the port and one trailing dot removed. IPv6 literals keep their brackets.
 * Returns null for anything that is not a plain `name[:port]` / `[v6][:port]`,
 * including userinfo, paths and whitespace, so an odd form can never match.
 */
export function parseHostname(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  const bracketed = /^(\[[0-9a-f:.]+\])(?::\d{1,5})?$/.exec(text);
  if (bracketed) {
    try {
      return new URL(`http://${bracketed[1]}/`).hostname;
    } catch {
      return null;
    }
  }
  const plain = /^([^:[\]]+)(?::\d{1,5})?$/.exec(text);
  if (!plain) return null;
  const name = plain[1].endsWith(".") ? plain[1].slice(0, -1) : plain[1];
  return HOSTNAME_PATTERN.test(name) ? name : null;
}

function matchesAllowedEntry(hostname: string, entry: string): boolean {
  if (!entry.startsWith("*.")) return hostname === entry;
  const suffix = entry.slice(1);
  return hostname.length > suffix.length && hostname.endsWith(suffix);
}

function allowedHostEntries(env: NodeJS.ProcessEnv): string[] {
  const entries: string[] = [];
  for (const raw of (env[ALLOWED_HOSTS_VAR] ?? "").split(",")) {
    const text = raw.trim();
    if (!text) continue;
    const wildcard = text.startsWith("*.");
    const hostname = parseHostname(wildcard ? text.slice(2) : text);
    if (hostname !== null) entries.push(wildcard ? `*.${hostname}` : hostname);
  }
  return entries;
}

/**
 * Whether a `Host` header value names this machine: `localhost`, any
 * `*.localhost`, 127.0.0.0/8, `[::1]`, or an entry of `OMP_WEB_ALLOWED_HOSTS`
 * (comma-separated, case-insensitive; a `:port` is ignored; `*.example.com`
 * matches subdomains but not `example.com` itself). Only the hostname is
 * compared. This is what stops a DNS-rebinding page, whose Host and Origin
 * both name the attacker's domain, from reaching a server that has no password.
 */
export function isHostAllowed(host: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const hostname = parseHostname(host);
  if (hostname === null) return false;
  if (hostname === "localhost" || hostname.endsWith(".localhost") || isLoopbackHost(hostname)) return true;
  return allowedHostEntries(env).some((entry) => matchesAllowedEntry(hostname, entry));
}

/** The authority the client addressed: the Host header, else the request URL's. */
export function getRequestHost(request: Request): string {
  return request.headers.get("host") ?? new URL(request.url).host;
}

export function isRequestHostAllowed(request: Request, env: NodeJS.ProcessEnv = process.env): boolean {
  return isHostAllowed(getRequestHost(request), env);
}
