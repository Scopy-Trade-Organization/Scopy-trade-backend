import { Response, RequestHandler } from "express";
import {
  validateCredentials,
  encryptCredentials,
  decryptCredentials,
} from "../services/exchangeService.js";
import { ExchangeConnection } from "../models/exchangeConnection.js";
import {
  AuthenticatedRequest,
  ConnectExchangeBody,
  ExchangeId,
  ExchangeListItem,
  ConnectionSummary,
  SUPPORTED_EXCHANGES,
  EncryptedCredentials,
} from "../types/index.js";

// ─── GET /api/exchanges ────────────────────────────────────────────────────────

export const getSupportedExchanges: RequestHandler = async (
  req,
  res,
): Promise<void> => {
  try {
    const userId = (req as AuthenticatedRequest).user.id;

    const connected = await ExchangeConnection.find(
      { userId, isActive: true },
      { exchange: 1 },
    );
    const connectedSet = new Set(connected.map((c) => c.exchange));

    const exchanges: ExchangeListItem[] = (
      Object.entries(SUPPORTED_EXCHANGES) as [
        ExchangeId,
        (typeof SUPPORTED_EXCHANGES)[ExchangeId],
      ][]
    ).map(([id, meta]) => ({
      id,
      name: meta.name,
      requiresPassphrase: meta.requiresPassphrase,
      fields: meta.fields,
      connected: connectedSet.has(id),
    }));

    res.json({ success: true, exchanges });
  } catch (err) {
    console.error("[getSupportedExchanges]", err);
    res.status(500).json({ success: false, message: "Internal server error." });
  }
};

// ─── POST /api/exchanges/connect ──────────────────────────────────────────────

export const connectExchange: RequestHandler = async (
  req,
  res,
): Promise<void> => {
  try {
    const userId = (req as AuthenticatedRequest).user.id;
    const { exchange, apiKey, apiSecret, passphrase, label } =
      req.body as ConnectExchangeBody;

    const exchangeMeta = SUPPORTED_EXCHANGES[exchange];

    // ── Check for duplicate ────────────────────────────────────────────────────
    const existing = await ExchangeConnection.findOne({
      userId,
      exchange,
      isActive: true,
    });

    if (existing) {
      res.status(409).json({
        success: false,
        message: `You already have an active ${exchangeMeta.name} connection. Remove it first to replace it.`,
      });
      return;
    }

    // ── Validate credentials with the exchange ─────────────────────────────────
    let accountInfo;
    try {
      accountInfo = await validateCredentials(exchange, {
        apiKey,
        apiSecret,
        passphrase,
      });
    } catch (validationError) {
      res.status(422).json({
        success: false,
        message: (validationError as Error).message,
        hint: "Double-check your API key, secret, and permissions in your exchange settings.",
      });
      return;
    }

    // ── Encrypt and persist ────────────────────────────────────────────────────
    const encrypted = encryptCredentials(exchange, {
      apiKey,
      apiSecret,
      passphrase,
    });

    const connection = await ExchangeConnection.create({
      userId,
      exchange,
      label: label ?? exchangeMeta.name,
      encryptedApiKey: encrypted.apiKey,
      encryptedApiSecret: encrypted.apiSecret,
      encryptedPassphrase: encrypted.passphrase ?? null,
      accountInfo,
      isActive: true,
      connectedAt: new Date(),
    });

    const summary: ConnectionSummary = {
      id: connection._id,
      exchange: connection.exchange,
      label: connection.label,
      accountInfo: connection.accountInfo,
      connectedAt: connection.connectedAt,
    };

    res.status(201).json({
      success: true,
      message: `${exchangeMeta.name} connected successfully.`,
      connection: summary,
    });
  } catch (err) {
    console.error("[connectExchange]", err);
    res.status(500).json({ success: false, message: "Internal server error." });
  }
};

// ─── GET /api/exchanges/connections ───────────────────────────────────────────

export const getUserConnections: RequestHandler = async (
  req,
  res,
): Promise<void> => {
  try {
    const userId = (req as AuthenticatedRequest).user.id;

    // Explicitly exclude encrypted fields — never sent to client
    const connections = await ExchangeConnection.find(
      { userId, isActive: true },
      { encryptedApiKey: 0, encryptedApiSecret: 0, encryptedPassphrase: 0 },
    ).sort({ connectedAt: -1 });

    res.json({ success: true, connections });
  } catch (err) {
    console.error("[getUserConnections]", err);
    res.status(500).json({ success: false, message: "Internal server error." });
  }
};

// ─── DELETE /api/exchanges/connections/:connectionId ──────────────────────────

export const removeConnection: RequestHandler = async (
  req,
  res,
): Promise<void> => {
  try {
    const userId = (req as AuthenticatedRequest).user.id;
    const { connectionId } = req.params;

    const connection = await ExchangeConnection.findOne({
      _id: connectionId,
      userId,
      isActive: true,
    });

    if (!connection) {
      res
        .status(404)
        .json({ success: false, message: "Connection not found." });
      return;
    }

    // Soft delete — wipe encrypted keys and mark inactive
    connection.isActive = false;
    connection.encryptedApiKey = null;
    connection.encryptedApiSecret = null;
    connection.encryptedPassphrase = null;
    connection.disconnectedAt = new Date();
    await connection.save();

    res.json({
      success: true,
      message: `${connection.label} disconnected successfully.`,
    });
  } catch (err) {
    console.error("[removeConnection]", err);
    res.status(500).json({ success: false, message: "Internal server error." });
  }
};

// ─── POST /api/exchanges/connections/:connectionId/test ───────────────────────

export const testConnection: RequestHandler = async (
  req,
  res,
): Promise<void> => {
  try {
    const userId = (req as AuthenticatedRequest).user.id;
    const { connectionId } = req.params;

    const connection = await ExchangeConnection.findOne({
      _id: connectionId,
      userId,
      isActive: true,
    });

    if (!connection) {
      res
        .status(404)
        .json({ success: false, message: "Connection not found." });
      return;
    }

    if (!connection.encryptedApiKey || !connection.encryptedApiSecret) {
      res.status(422).json({
        success: false,
        message: "Credentials are missing. Please reconnect this exchange.",
      });
      return;
    }

    const storedCredentials: EncryptedCredentials = {
      exchange: connection.exchange,
      apiKey: connection.encryptedApiKey,
      apiSecret: connection.encryptedApiSecret,
      passphrase: connection.encryptedPassphrase ?? undefined,
    };

    const credentials = decryptCredentials(storedCredentials);

    let accountInfo;
    try {
      accountInfo = await validateCredentials(connection.exchange, credentials);
    } catch (validationError) {
      connection.lastTestedAt = new Date();
      connection.lastTestStatus = "failed";
      await connection.save();

      res.status(422).json({
        success: false,
        message: (validationError as Error).message,
        hint: "Your API keys may have expired or been revoked. Please reconnect.",
      });
      return;
    }

    connection.accountInfo = accountInfo;
    connection.lastTestedAt = new Date();
    connection.lastTestStatus = "ok";
    await connection.save();

    res.json({
      success: true,
      message: "Connection is active and working.",
      accountInfo,
    });
  } catch (err) {
    console.error("[testConnection]", err);
    res.status(500).json({ success: false, message: "Internal server error." });
  }
};
