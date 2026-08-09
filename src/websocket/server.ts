/**
 * websocket/server.ts
 *
 * Frontend-facing WebSocket server for real-time trade updates.
 * Authenticates users via JWT, supports trade subscriptions,
 * and broadcasts updates from the TradeMonitorService.
 */

import WebSocket, { WebSocketServer as WsServer } from "ws";
import { Server as HttpServer } from "http";
import { IncomingMessage } from "http";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { Trade } from "../models/tradeModel.js";
import Admin from "../models/adminModel.js";
import { getTradeMonitorService } from "../services/tradeMonitorService.js";

// ─── Types ──────────────────────────────────────────────────────────────────

interface WebSocketClient {
  ws: WebSocket;
  userId: string;
  isAdmin: boolean;
  isAuthenticated: boolean;
  subscribedTrades: Set<string>;
}

interface ClientMessage {
  type: string;
  data?: any;
  tradeId?: string;
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

// ─── WebSocket Server ───────────────────────────────────────────────────────

export class TradeWebSocketServer {
  private wss: WsServer;
  private clients: Map<string, WebSocketClient> = new Map();

  constructor(server: HttpServer) {
    this.wss = new WsServer({
      server,
      path: "/ws/trades",
    });

    this.setupServer();
    this.setupMonitorListener();

    console.log("[WebSocketServer] Initialized on /ws/trades");
  }

  // ─── Server Setup ───────────────────────────────────────────────────────

  private setupServer(): void {
    this.wss.on("connection", async (ws: WebSocket, req: IncomingMessage) => {
      const origin = req.headers.origin;
      const allowedOrigins = [
        process.env.FRONTEND_URL,
        process.env.FRONTEND_LOCALHOST,
      ].filter(Boolean) as string[];
      if (origin && !allowedOrigins.includes(origin)) {
        ws.close(1008, "Origin not allowed");
        return;
      }

      const userToken = readCookie(req.headers.cookie, "user_token");
      const adminToken = readCookie(req.headers.cookie, "admin_token");

      // Authenticate via JWT
      let userId: string | null = null;
      let isAdmin = false;

      try {
        const token = userToken || adminToken;
        if (!token) throw new Error("Authentication cookie is missing.");

        const secret = process.env.JWT_SECRET;
        if (!secret) throw new Error("JWT_SECRET not configured.");

        const decoded = jwt.verify(token, secret) as { id: string };
        if (!decoded?.id) throw new Error("Invalid token payload.");

        userId = decoded.id;
        if (adminToken && !userToken) {
          const admin = await Admin.exists({ _id: userId });
          if (!admin) throw new Error("Admin not found.");
          isAdmin = true;
        }
      } catch (err) {
        ws.send(
          JSON.stringify({
            type: "error",
            code: "UNAUTHORIZED",
            message:
              err instanceof Error
                ? err.message
                : "Invalid or missing authentication token",
          }),
        );
        ws.close(1008, "Unauthorized");
        return;
      }

      // Close existing connection for this user if any
      const clientKey = `${isAdmin ? "admin" : "user"}:${userId}`;
      const existing = this.clients.get(clientKey);
      if (existing) {
        existing.ws.close(1000, "New connection established");
        this.clients.delete(clientKey);
      }

      const client: WebSocketClient = {
        ws,
        userId,
        isAdmin,
        isAuthenticated: true,
        subscribedTrades: new Set(),
      };

      this.clients.set(clientKey, client);

      // Send connection acknowledgment
      this.sendToClient(client, {
        type: "connected",
        timestamp: new Date().toISOString(),
      });

      console.log(`[WebSocketServer] Client connected: ${userId}`);

      // Handle messages
      ws.on("message", async (data: WebSocket.Data) => {
        try {
          const message: ClientMessage = JSON.parse(data.toString());
          await this.handleMessage(client, message);
        } catch (err) {
          this.sendToClient(client, {
            type: "error",
            code: "INVALID_MESSAGE",
            message: "Invalid message format",
          });
        }
      });

      ws.on("close", () => {
        this.clients.delete(clientKey);
        console.log(`[WebSocketServer] Client disconnected: ${userId}`);
      });

      ws.on("error", (err: Error) => {
        console.error(`[WebSocketServer] Client error ${userId}:`, err);
        this.clients.delete(clientKey);
      });

      // Ping keepalive every 30 seconds
      const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        } else {
          clearInterval(pingInterval);
        }
      }, 30000);

      ws.on("close", () => clearInterval(pingInterval));
    });
  }

  // ─── Monitor Listener ──────────────────────────────────────────────────

  private setupMonitorListener(): void {
    const monitor = getTradeMonitorService();

    // Real-time trade status updates (pending → filled, etc.)
    monitor.on("tradeUpdate", (data) => {
      this.broadcastToTradeSubscribers(data.tradeId, {
        type: "trade_update",
        data: {
          tradeId: data.tradeId,
          exchangeOrderId: data.exchangeOrderId,
          exchange: data.exchange,
          status: data.status,
          filledPrice: data.filledPrice,
          filledQuantity: data.filledQuantity,
          tp: data.tp,
          sl: data.sl,
          timestamp: data.timestamp,
        },
      });
    });

    monitor.on("monitoringUpdate", (data) => {
      this.broadcastToTradeSubscribers(data.tradeId, {
        type: "monitoring_update",
        data,
      });
    });

    // Trade closed (TP/SL/manual) with PnL
    monitor.on("tradeClosed", (data) => {
      this.broadcastToTradeSubscribers(data.tradeId, {
        type: "trade_closed",
        data: {
          tradeId: data.tradeId,
          realizedPnl: data.realizedPnl,
          platformFee: data.platformFee,
          feeStatus: data.feeStatus,
          tradeResult: data.tradeResult,
        },
      });
    });
  }

  // ─── Message Handlers ──────────────────────────────────────────────────

  private async handleMessage(
    client: WebSocketClient,
    message: ClientMessage,
  ): Promise<void> {
    switch (message.type) {
      case "subscribe_trade":
        await this.subscribeTrade(client, message.tradeId || message.data);
        break;

      case "unsubscribe_trade":
        this.unsubscribeTrade(client, message.tradeId || message.data);
        break;

      case "get_active_trades":
        await this.sendActiveTrades(client);
        break;

      default:
        this.sendToClient(client, {
          type: "error",
          code: "UNKNOWN_TYPE",
          message: `Unknown message type: ${message.type}`,
        });
    }
  }

  private async subscribeTrade(
    client: WebSocketClient,
    tradeId: string,
  ): Promise<void> {
    if (!tradeId || !mongoose.isValidObjectId(tradeId)) {
      this.sendToClient(client, {
        type: "error",
        code: "INVALID_TRADE_ID",
        message: "Invalid trade ID.",
      });
      return;
    }

    // Users may monitor their own trades and active public pro trades.
    const trade = await Trade.findOne(
      client.isAdmin
        ? { _id: tradeId }
        : {
            _id: tradeId,
            $or: [
              { userId: client.userId },
              { tradeOrigin: "pro", status: { $in: ["pending", "filled"] } },
            ],
          },
    ).lean();

    if (!trade) {
      this.sendToClient(client, {
        type: "error",
        code: "NOT_FOUND",
        message: "Trade not found or access denied.",
      });
      return;
    }

    client.subscribedTrades.add(tradeId);

    // Send current trade state immediately
    this.sendToClient(client, {
      type: "trade_state",
      data: {
        tradeId,
        status: trade.status,
        entryPrice: trade.entryPrice,
        entryFillPrice: trade.entryFillPrice,
        exitPrice: trade.exitPrice,
        tp: trade.tp,
        sl: trade.sl,
        direction: trade.direction,
        quantity: trade.quantity,
        pair: trade.pair,
        realizedPnl: trade.realizedPnl,
        platformFee: trade.platformFee,
        feeStatus: trade.feeStatus,
        tradeResult: trade.tradeResult,
        closedVia: trade.closedVia,
        wsMonitoringActive: trade.wsMonitoringActive,
        monitoringStatus: trade.monitoringStatus,
        monitoringError: trade.monitoringError,
        monitoringConnectedAt: trade.monitoringConnectedAt,
        lastCheckedAt: trade.lastCheckedAt,
        createdAt: trade.createdAt,
        closedAt: trade.closedAt,
      },
    });

    console.log(
      `[WebSocketServer] User ${client.userId} subscribed to trade ${tradeId}`,
    );
  }

  private unsubscribeTrade(client: WebSocketClient, tradeId: string): void {
    if (!tradeId) return;
    client.subscribedTrades.delete(tradeId);
    console.log(
      `[WebSocketServer] User ${client.userId} unsubscribed from trade ${tradeId}`,
    );
  }

  private async sendActiveTrades(client: WebSocketClient): Promise<void> {
    const trades = await Trade.find(
      client.isAdmin
        ? { status: { $in: ["pending", "filled"] } }
        : { userId: client.userId, status: { $in: ["pending", "filled"] } },
    )
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    this.sendToClient(client, {
      type: "active_trades",
      data: trades.map((t) => ({
        tradeId: String(t._id),
        pair: t.pair,
        direction: t.direction,
        status: t.status,
        entryPrice: t.entryPrice,
        tp: t.tp,
        sl: t.sl,
        quantity: t.quantity,
        wsMonitoringActive: t.wsMonitoringActive,
        monitoringStatus: t.monitoringStatus,
        monitoringError: t.monitoringError,
        monitoringConnectedAt: t.monitoringConnectedAt,
        lastCheckedAt: t.lastCheckedAt,
        createdAt: t.createdAt,
      })),
    });
  }

  // ─── Broadcasting ─────────────────────────────────────────────────────

  private broadcastToTradeSubscribers(tradeId: string, message: any): void {
    const serialized = JSON.stringify(message);

    for (const [, client] of this.clients) {
      if (
        client.subscribedTrades.has(tradeId) &&
        client.ws.readyState === WebSocket.OPEN
      ) {
        client.ws.send(serialized);
      }
    }
  }

  /**
   * Broadcast a message to all connected, authenticated clients.
   */
  public broadcast(message: any): void {
    const serialized = JSON.stringify(message);

    for (const [, client] of this.clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(serialized);
      }
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private sendToClient(client: WebSocketClient, message: any): void {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(message));
    }
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────

  public shutdown(): void {
    console.log("[WebSocketServer] Shutting down...");

    for (const [, client] of this.clients) {
      client.ws.close(1001, "Server shutting down");
    }

    this.clients.clear();
    this.wss.close();

    console.log("[WebSocketServer] Shutdown complete.");
  }

  public getConnectedClientCount(): number {
    return this.clients.size;
  }
}
