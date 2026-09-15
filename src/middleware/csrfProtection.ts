import crypto from "crypto";
import type { CookieOptions, NextFunction, Request, Response } from "express";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const CSRF_COOKIE = "csrf_token";
const CSRF_HEADER = "x-csrf-token";

export function isSecureRequest(req: Request): boolean {
  return req.secure || req.headers["x-forwarded-proto"] === "https";
}

export function csrfCookieOptions(req: Request): CookieOptions {
  const secure = isSecureRequest(req);
  return {
    httpOnly: false,
    secure,
    sameSite: secure ? "none" : "lax",
    path: "/",
  };
}

export function setCsrfToken(req: Request, res: Response): void {
  res.cookie(CSRF_COOKIE, crypto.randomBytes(32).toString("hex"), {
    ...csrfCookieOptions(req),
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

/** Protects cookie-authenticated state changes with a double-submit token. */
export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  const publicPostPaths = new Set([
    "/api/auth/login",
    "/api/auth/register",
    "/api/auth/verify-signup",
    "/api/auth/resend-signup-otp",
    "/api/auth/forgot-password",
    "/api/auth/reset-password",
    "/api/admin/auth/login",
  ]);
  const routePath = `${req.baseUrl}${req.path}`;
  if (SAFE_METHODS.has(req.method) || publicPostPaths.has(routePath)) {
    next();
    return;
  }

  const cookieToken = req.cookies?.[CSRF_COOKIE];
  const headerToken = req.get(CSRF_HEADER);
  if (
    typeof cookieToken !== "string" ||
    typeof headerToken !== "string" ||
    cookieToken.length !== headerToken.length ||
    !crypto.timingSafeEqual(Buffer.from(cookieToken), Buffer.from(headerToken))
  ) {
    res.status(403).json({ status: "fail", message: "Invalid CSRF token" });
    return;
  }

  next();
}
