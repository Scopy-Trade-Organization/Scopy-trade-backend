import { Request, Response, NextFunction } from "express";
import {
  ExchangeId,
  ConnectExchangeBody,
  SUPPORTED_EXCHANGES,
  PASSPHRASE_REQUIRED,
} from "../types/index.js";

export const validateConnectBody = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const errors: string[] = [];
  const { exchange, apiKey, apiSecret, passphrase, label } =
    req.body as Partial<ConnectExchangeBody>;

  // ── exchange ───────────────────────────────────────────────────────────────
  if (!exchange || typeof exchange !== "string") {
    errors.push("exchange is required.");
  } else if (!(exchange.toLowerCase() in SUPPORTED_EXCHANGES)) {
    errors.push(
      `Invalid exchange. Must be one of: ${Object.keys(SUPPORTED_EXCHANGES).join(", ")}.`,
    );
  }

  // ── apiKey ─────────────────────────────────────────────────────────────────
  if (!apiKey || typeof apiKey !== "string" || apiKey.trim().length === 0) {
    errors.push("apiKey is required.");
  } else if (apiKey.trim().length < 8) {
    errors.push("apiKey appears too short. Please double-check it.");
  }

  // ── apiSecret ──────────────────────────────────────────────────────────────
  if (
    !apiSecret ||
    typeof apiSecret !== "string" ||
    apiSecret.trim().length === 0
  ) {
    errors.push("apiSecret is required.");
  } else if (apiSecret.trim().length < 8) {
    errors.push("apiSecret appears too short. Please double-check it.");
  }

  // ── passphrase (exchange-specific) ────────────────────────────────────────
  if (
    exchange &&
    PASSPHRASE_REQUIRED.includes(exchange.toLowerCase() as ExchangeId)
  ) {
    if (
      !passphrase ||
      typeof passphrase !== "string" ||
      passphrase.trim().length === 0
    ) {
      errors.push(`passphrase is required for ${exchange}.`);
    }
  }

  // ── label (optional) ──────────────────────────────────────────────────────
  if (label !== undefined && typeof label !== "string") {
    errors.push("label must be a string.");
  }
  if (label && label.length > 64) {
    errors.push("label must be 64 characters or fewer.");
  }

  if (errors.length > 0) {
    res.status(400).json({ success: false, errors });
    return;
  }

  // Normalize before passing to controller
  req.body.exchange = (exchange as string).toLowerCase() as ExchangeId;
  req.body.apiKey = (apiKey as string).trim();
  req.body.apiSecret = (apiSecret as string).trim();
  if (passphrase) req.body.passphrase = passphrase.trim();

  next();
};
