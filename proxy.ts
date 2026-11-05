import { NextResponse, type NextRequest } from "next/server";
import {
  ALLOWED_HOSTS_VAR,
  getRequestHost,
  isApiRequestOriginAllowed,
  isRequestHostAllowed,
  shouldCheckApiRequestOrigin,
} from "@/lib/request-security";
import {
  isTrustedProxyRequest,
  isValidWebSession,
  isWebPasswordEnabled,
  webPasswordConfigurationProblem,
  OMP_WEB_SESSION_COOKIE,
  OMP_WEB_TRUSTED_HEADER,
} from "@/lib/web-auth";

// The Origin check below compares against the request's own Host header, so a
// DNS-rebinding page (Host and Origin both naming the attacker's domain) passes
// it. Without a password nothing else authenticates the caller, so such a
// server only answers requests addressed to this machine. With a password (or
// a trusted proxy header, which is only honoured next to one) requests are
// authenticated and the Host is the operator's business.
function hostNotAllowedResponse(request: NextRequest): NextResponse {
  // The Host value is attacker-controlled: show a bounded, printable form.
  const shown = JSON.stringify(getRequestHost(request).replace(/[^\x20-\x7e]/g, "").slice(0, 100));
  const fix = `Add the hostname to ${ALLOWED_HOSTS_VAR} (comma-separated, e.g. ${ALLOWED_HOSTS_VAR}=foxnio.example.com), or protect the server with a password: foxnio hash-password, then set OMP_WEB_PASSWORD_HASH.`;
  const message = `Host ${shown} is not allowed: without a password foxnio only answers requests for localhost and loopback addresses.`;
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: `${message} ${fix}`, code: "host_not_allowed" }, { status: 403 });
  }
  return new NextResponse(`foxnio refused this request\n\n${message}\n\n${fix}\n`, {
    status: 403,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

export function proxy(request: NextRequest) {
  const passwordEnabled = isWebPasswordEnabled();
  if (!passwordEnabled && !isRequestHostAllowed(request)) return hostNotAllowedResponse(request);
  if (request.nextUrl.pathname.startsWith("/api/") && shouldCheckApiRequestOrigin(request) && !isApiRequestOriginAllowed(request)) {
    return NextResponse.json({ error: "Cross-origin API requests are not allowed" }, { status: 403 });
  }
  // A configured-but-unusable password (plaintext, or a truncated hash) must
  // never degrade into an open server: refuse every request with the fix. The
  // problem is also reported once at startup (instrumentation.node.ts), so this
  // deliberately logs nothing — a doomed request loop must not flood the log.
  const passwordProblem = webPasswordConfigurationProblem();
  if (passwordProblem) {
    return new NextResponse(`foxnio password configuration error\n\n${passwordProblem}\n`, {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  if (!passwordEnabled) {
    return request.nextUrl.pathname === "/login"
      ? NextResponse.redirect(new URL("/", request.url))
      : NextResponse.next();
  }

  const { pathname } = request.nextUrl;
  const hasSession = isTrustedProxyRequest(request.headers.get(OMP_WEB_TRUSTED_HEADER))
    || isValidWebSession(request.cookies.get(OMP_WEB_SESSION_COOKIE)?.value);
  if (pathname === "/login") {
    return hasSession ? NextResponse.redirect(new URL("/", request.url)) : NextResponse.next();
  }
  if (pathname === "/api/web-auth/session") return NextResponse.next();
  if (hasSession) return NextResponse.next();
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Password required", code: "password_required" }, { status: 401 });
  }
  const login = new URL("/login", request.url);
  // Keep a deep link to a session (e.g. a notification click) across sign-in.
  if (pathname === "/" && request.nextUrl.search) login.searchParams.set("next", `/${request.nextUrl.search}`);
  return NextResponse.redirect(login);
}

// The sign-in screen still needs its Next.js JavaScript and CSS before a
// session exists; these and the ordinary browser icons are public assets,
// not workspace data. /api/manifest stays authenticated: its link includes
// credentials and its embedded installation icons need no separate request.
// The service worker script holds no data either, and the browser re-fetches
// it for update checks even after the sign-in cookie expired.
// Every exclusion is anchored (a directory prefix ending in "/", or a whole
// file name ending in "$"), so a longer path such as /sw.js.map or /icon.png/x
// stays behind the proxy. /_next/image is deliberately not excluded: the app
// never uses next/image (next.config.ts disables the optimizer), so the route
// has no business being public.
export const config = { matcher: "/((?!_next/static/|favicon\\.ico$|icon\\.svg$|icon\\.png$|icon-192\\.png$|badge-96\\.png$|sw\\.js$).*)" };
