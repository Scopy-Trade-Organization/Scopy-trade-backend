import { Request, Response, RequestHandler } from "express";
import {
  validateCredentials,
  encryptCredentials,
  decryptCredentials,
} from "../services/exchangeService.js";
import { ExchangeConnection } from "../models/exchangeConnectionModel.js";
import {
  ConnectExchangeBody,
  ExchangeId,
  ExchangeListItem,
  ConnectionSummary,
  SUPPORTED_EXCHANGES,
  EncryptedCredentials,
} from "../types/index.js";

export const getSupportedExchanges = async (req: Request, res: Response) => {
  try {
    const userId = req.user;

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

    return res.status(200).json({
      success: true,
      exchanges,
    });
  } catch (err) {
    console.error("[getSupportedExchanges]", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};

export const connectExchange: RequestHandler = async (
  req: Request,
  res: Response,
) => {
  try {
    const userId = req.user;
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
      return res.status(409).json({
        success: false,
        message: `You already have an active ${exchangeMeta.name} connection. Remove it first to replace it.`,
      });
    }

    // ── Validate credentials with the exchange ─────────────────────────────────
    let accountInfo;
    try {
      accountInfo = await validateCredentials(exchange, {
        apiKey,
        apiSecret,
        ...(passphrase !== undefined && { passphrase }),
      });
    } catch (validationError) {
      return res.status(422).json({
        success: false,
        message: (validationError as Error).message,
        hint: "Double-check your API key, secret, and permissions in your exchange settings.",
      });
    }

    // ── Encrypt and persist ────────────────────────────────────────────────────
    const encrypted = encryptCredentials(exchange, {
      apiKey,
      apiSecret,
      ...(passphrase !== undefined && { passphrase }),
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

    return res.status(201).json({
      success: true,
      message: `${exchangeMeta.name} connected successfully.`,
      connection: summary,
    });
  } catch (err) {
    console.error("[connectExchange]", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};

// ─── GET /api/exchanges/connections ───────────────────────────────────────────

export const getUserConnections: RequestHandler = async (
  req: Request,
  res: Response,
) => {
  try {
    const userId = req.user;

    // Explicitly exclude encrypted fields — never sent to client
    const connections = await ExchangeConnection.find(
      { userId, isActive: true },
      { encryptedApiKey: 0, encryptedApiSecret: 0, encryptedPassphrase: 0 },
    ).sort({ connectedAt: -1 });

    return res.status(200).json({
      success: true,
      connections,
    });
  } catch (err) {
    console.error("[getUserConnections]", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};

// ─── DELETE /api/exchanges/connections/:connectionId ──────────────────────────

export const removeConnection: RequestHandler = async (
  req: Request,
  res: Response,
) => {
  try {
    const userId = req.user;
    const { connectionId } = req.params;

    const connection = await ExchangeConnection.findOne({
      _id: connectionId,
      userId,
      isActive: true,
    });

    if (!connection) {
      return res.status(404).json({
        success: false,
        message: "Connection not found.",
      });
    }

    // Soft delete — wipe encrypted keys and mark inactive
    connection.isActive = false;
    connection.encryptedApiKey = null;
    connection.encryptedApiSecret = null;
    connection.encryptedPassphrase = null;
    connection.disconnectedAt = new Date();
    await connection.save();

    return res.status(200).json({
      success: true,
      message: `${connection.label} disconnected successfully.`,
    });
  } catch (err) {
    console.error("[removeConnection]", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};

export const testConnection: RequestHandler = async (
  req: Request,
  res: Response,
) => {
  try {
    const userId = req.user;
    const { connectionId } = req.params;

    const connection = await ExchangeConnection.findOne({
      _id: connectionId,
      userId,
      isActive: true,
    });

    if (!connection) {
      return res.status(404).json({
        success: false,
        message: "Connection not found.",
      });
    }

    if (!connection.encryptedApiKey || !connection.encryptedApiSecret) {
      return res.status(422).json({
        success: false,
        message: "Credentials are missing. Please reconnect this exchange.",
      });
    }

    const storedCredentials: EncryptedCredentials = {
      exchange: connection.exchange,
      apiKey: connection.encryptedApiKey,
      apiSecret: connection.encryptedApiSecret,
      ...(connection.encryptedPassphrase != null && {
        passphrase: connection.encryptedPassphrase,
      }),
    };

    const credentials = decryptCredentials(storedCredentials);

    let accountInfo;
    try {
      accountInfo = await validateCredentials(connection.exchange, credentials);
    } catch (validationError) {
      connection.lastTestedAt = new Date();
      connection.lastTestStatus = "failed";
      await connection.save();

      return res.status(422).json({
        success: false,
        message: (validationError as Error).message,
        hint: "Your API keys may have expired or been revoked. Please reconnect.",
      });
    }

    connection.accountInfo = accountInfo;
    connection.lastTestedAt = new Date();
    connection.lastTestStatus = "ok";
    await connection.save();

    return res.status(200).json({
      success: true,
      message: "Connection is active and working.",
      accountInfo,
    });
  } catch (err) {
    console.error("[testConnection]", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};
