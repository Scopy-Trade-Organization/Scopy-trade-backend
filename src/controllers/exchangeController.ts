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
import AuditLog from "../models/auditLogModel.js";

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

export const connectExchange = async (req: Request, res: Response) => {
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
      console.error("[VALIDATION FAILED]", {
        exchange,
        userId,
        error: (validationError as Error).message,
        time: new Date().toISOString(),
      });

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

    await AuditLog.create({
      userId,
      action: `${exchangeMeta.name} Connected`,
      details: { exchange: connection.exchange, connectionId: connection._id },
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

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

export const getUserConnections = async (req: Request, res: Response) => {
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

export const removeConnection = async (req: Request, res: Response) => {
  try {
    const userId = req.user;
    const { connectionId } = req.params;

    const connection = await ExchangeConnection.findOneAndDelete({
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

    await AuditLog.create({
      userId,
      action: `${SUPPORTED_EXCHANGES[connection.exchange].name} Disconnected`,
      details: { exchange: connection.exchange, connectionId: connection._id },
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

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

export const testConnection = async (req: Request, res: Response) => {
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

export const updateConnectionCredentials = async (
  req: Request,
  res: Response,
) => {
  try {
    const userId = req.user;
    const { connectionId } = req.params;
    const { apiKey, apiSecret, passphrase } = req.body;

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

    // Validate new credentials
    let accountInfo;
    try {
      accountInfo = await validateCredentials(connection.exchange, {
        apiKey,
        apiSecret,
        ...(passphrase && { passphrase }),
      });
    } catch (err) {
      return res.status(422).json({
        success: false,
        message: (err as Error).message,
      });
    }

    // Encrypt new credentials
    const encrypted = encryptCredentials(connection.exchange, {
      apiKey,
      apiSecret,
      ...(passphrase && { passphrase }),
    });

    // Update
    connection.encryptedApiKey = encrypted.apiKey;
    connection.encryptedApiSecret = encrypted.apiSecret;
    connection.encryptedPassphrase = encrypted.passphrase ?? null;
    connection.accountInfo = accountInfo;
    connection.lastTestStatus = "ok";
    connection.lastTestedAt = new Date();

    await connection.save();

    await AuditLog.create({
      userId,
      action: `${SUPPORTED_EXCHANGES[connection.exchange].name} Credentials Updated`,
      details: { exchange: connection.exchange, connectionId: connection._id },
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    return res.status(200).json({
      success: true,
      message: "Credentials updated successfully.",
    });
  } catch (err) {
    console.error("[updateConnectionCredentials]", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};
