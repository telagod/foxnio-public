import { NextResponse } from "next/server";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { loginThrottle, loginThrottleKey } from "@/lib/login-throttle";
import {
  createWebSession,
  isWebPasswordEnabled,
  OMP_WEB_SESSION_COOKIE,
  OMP_WEB_SESSION_MAX_AGE_SECONDS,
  verifyWebPassword,
} from "@/lib/web-auth";

const MAX_PASSWORD_REQUEST_BYTES = 8 * 1024;

export async function POST(request: Request) {
  if (!isWebPasswordEnabled()) {
    return NextResponse.json({ error: "Password protection is disabled" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await parseJsonWithinLimit(request, MAX_PASSWORD_REQUEST_BYTES);
  } catch (error) {
    const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
    return NextResponse.json({ error: "Invalid password request" }, { status });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid password request" }, { status: 400 });
  }
  const { password } = body as { password?: unknown };
  if (typeof password !== "string") {
    return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
  }

  const attempt = loginThrottle.begin(loginThrottleKey(request.headers));
  if (!attempt.allowed) {
    return NextResponse.json(
      { error: "Too many sign-in attempts. Try again later.", code: "too_many_attempts" },
      { status: 429, headers: { "Retry-After": String(attempt.retryAfterSeconds) } },
    );
  }
  let valid = false;
  try {
    valid = await verifyWebPassword(password);
  } finally {
    attempt.finish(valid);
  }
  if (!valid) return NextResponse.json({ error: "Incorrect password" }, { status: 401 });

  const response = NextResponse.json({ ok: true });
  const secure = new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  response.cookies.set({
    name: OMP_WEB_SESSION_COOKIE,
    value: createWebSession(),
    httpOnly: true,
    secure,
    sameSite: "lax",
    maxAge: OMP_WEB_SESSION_MAX_AGE_SECONDS,
    path: "/",
  });
  return response;
}
