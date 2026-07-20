/**
 * tradeMonitorService.ts
 *
 * Manages per-trade WebSocket connections to exchanges for real-time monitoring.
 * Supports Binance Futures and Bitget Futures (demo mode).
 *
 * Architecture:
 * - One WebSocket connection per exchange per user (shared across trades)
 * - Monitors order fills, position updates, and TP/SL triggers
 * - Emits events consumed by the frontend WebSocket server
 */

import crypto from "crypto";
import WebSocket from "ws";
import { EventEmitter } from "events";
import { Trade } from "../models/tradeModel.js";
import { ExchangeConnection } from "../models/exchangeConnectionModel.js";
import { decryptCredentials } from "./exchangeConnectionService.js";
import { http } from "./exchangeConnectionService.js";
import { processTradeClose } from "./profitSharingService.js";
import { ExchangeId } from "../types/index.js";

// ─── Types ──────────────────────────────────────────────────────────────────

interface MonitoredTrade {
  tradeId: string;
  exchangeOrderId: string;
  pair: string;
  direction: "buy" | "sell";
  quantity: string;
  entryPrice: string;
  tp: string;
  sl: string;
}

interface ExchangeWsConnection {
  exchange: ExchangeId;
  userId: string;
  connectionId: string;
  ws: WebSocket | null;
  credentials: {
    apiKey: string;
    apiSecret: string;
    passphrase?: string;
  };
  activeTrades: Map<string, MonitoredTrade>; // orderId → trade
  isConnected: boolean;
  reconnectAttempts: number;
  reconnectTimer: NodeJS.Timeout | null;
  keepaliveTimer: NodeJS.Timeout | null;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_RECONNECT_ATTEMPTS = 10;
const MAX_RECONNECT_DELAY_MS = 60000;
const BINANCE_LISTENKEY_REFRESH_MS = 30 * 60 * 1000; // 30 minutes
const BITGET_PING_INTERVAL_MS = 30000;

// ─── Trade Monitor Service ──────────────────────────────────────────────────

export class TradeMonitorService extends EventEmitter {
  private connections: Map<string, ExchangeWsConnection> = new Map();
  private binanceListenKeys: Map<string, string> = new Map(); // connectionId → listenKey
  private binanceListenKeyTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor() {
    super();
    this.setMaxListeners(50);
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  /**
   * Start monitoring a trade. Opens an exchange WS connection if one isn't
   * already active for this user+exchange combination.
   */
  async startMonitoring(tradeId: string): Promise<void> {
    const trade = await Trade.findById(tradeId).lean();
    if (!trade) {
      console.error(`[TradeMonitor] Trade ${tradeId} not found.`);
      return;
    }

    if (!trade.exchangeOrderId) {
      console.error(`[TradeMonitor] Trade ${tradeId} has no exchangeOrderId.`);
      return;
    }

    const connection = await ExchangeConnection.findById(
      trade.exchangeConnectionId,
    ).lean();

    if (!connection) {
      console.error(`[TradeMonitor] Connection for trade ${tradeId} not found.`);
      return;
    }

    const exchange = connection.exchange as ExchangeId;

    // Only support Binance and Bitget
    if (exchange !== "binance" && exchange !== "bitget") {
      console.warn(
        `[TradeMonitor] Exchange ${exchange} not supported for WS monitoring.`,
      );
      return;
    }

    const connKey = `${String(connection.userId)}_${exchange}`;

    const monitoredTrade: MonitoredTrade = {
      tradeId: String(trade._id),
      exchangeOrderId: trade.exchangeOrderId,
      pair: trade.pair,
      direction: trade.direction as "buy" | "sell",
      quantity: trade.quantity,
      entryPrice: trade.entryPrice,
      tp: trade.tp,
      sl: trade.sl,
    };

    let wsConn = this.connections.get(connKey);

    if (!wsConn) {
      // Decrypt credentials
      const storedCreds = {
        exchange: connection.exchange as ExchangeId,
        apiKey: connection.encryptedApiKey!,
        apiSecret: connection.encryptedApiSecret!,
        ...(connection.encryptedPassphrase
          ? { passphrase: connection.encryptedPassphrase }
          : {}),
      };
      const rawCreds = decryptCredentials(storedCreds);

      wsConn = {
        exchange,
        userId: String(connection.userId),
        connectionId: String(connection._id),
        ws: null,
        credentials: {
          apiKey: rawCreds.apiKey,
          apiSecret: rawCreds.apiSecret,
          ...(rawCreds.passphrase ? { passphrase: rawCreds.passphrase } : {}),
        },
        activeTrades: new Map(),
        isConnected: false,
        reconnectAttempts: 0,
        reconnectTimer: null,
        keepaliveTimer: null,
      };

      this.connections.set(connKey, wsConn);
    }

    // Add trade to active monitoring
    wsConn!.activeTrades.set(trade.exchangeOrderId, monitoredTrade);

    // Connect WS if not already connected
    if (!wsConn!.isConnected && !wsConn!.ws) {
      if (exchange === "binance") {
        await this.connectBinance(wsConn!);
      } else if (exchange === "bitget") {
        await this.connectBitget(wsConn!);
      }
    }

    console.log(
      `[TradeMonitor] Now monitoring trade ${tradeId} (${exchange} order ${trade.exchangeOrderId})`,
    );
  }

  /**
   * Stop monitoring a specific trade. If no more trades are active on the
   * connection, close the WebSocket.
   */
  async stopMonitoring(tradeId: string): Promise<void> {
    for (const [connKey, wsConn] of this.connections) {
      for (const [orderId, monitored] of wsConn.activeTrades) {
        if (monitored.tradeId === tradeId) {
          wsConn.activeTrades.delete(orderId);
          console.log(`[TradeMonitor] Stopped monitoring trade ${tradeId}`);

          // Update DB
          await Trade.updateOne(
            { _id: tradeId },
            { $set: { wsMonitoringActive: false } },
          );

          // If no more trades, close the connection
          if (wsConn.activeTrades.size === 0) {
            this.closeConnection(connKey);
          }

          return;
        }
      }
    }
  }

  /**
   * Resume monitoring all pending/filled trades on startup.
   */
  async resumeActiveMonitoring(): Promise<void> {
    const activeTrades = await Trade.find({
      status: { $in: ["pending", "filled"] },
      exchangeOrderId: { $ne: null },
      wsMonitoringActive: true,
    }).lean();

    console.log(
      `[TradeMonitor] Resuming monitoring for ${activeTrades.length} active trades`,
    );

    for (const trade of activeTrades) {
      try {
        await this.startMonitoring(String(trade._id));
      } catch (err: any) {
        console.error(
          `[TradeMonitor] Failed to resume monitoring for trade ${trade._id}:`,
          err,
        );
      }
    }
  }

  /**
   * Graceful shutdown — close all WebSocket connections.
   */
  async shutdown(): Promise<void> {
    console.log("[TradeMonitor] Shutting down...");

    for (const [connKey] of this.connections) {
      this.closeConnection(connKey);
    }

    // Clear Binance listenKey timers
    for (const [, timer] of this.binanceListenKeyTimers) {
      clearInterval(timer);
    }
    this.binanceListenKeyTimers.clear();
    this.binanceListenKeys.clear();

    console.log("[TradeMonitor] Shutdown complete.");
  }

  // ─── Binance Futures WebSocket ──────────────────────────────────────────

  private async connectBinance(wsConn: ExchangeWsConnection): Promise<void> {
    const { apiKey, apiSecret } = wsConn.credentials;
    const baseUrl =
      process.env.BINANCE_TEST_API_URL || "https://testnet.binancefuture.com";
    const wsUrl =
      process.env.BINANCE_WS_URL || "wss://fstream.binancefuture.com";

    try {
      // 1. Create listenKey via REST
      const { data: timeData } = await http.get(`${baseUrl}/fapi/v1/time`);
      const timestamp = timeData.serverTime as number;
      const qs = `timestamp=${timestamp}`;
      const sig = crypto
        .createHmac("sha256", apiSecret)
        .update(qs)
        .digest("hex");

      const { data: listenKeyData } = await http.post(
        `${baseUrl}/fapi/v1/listenKey`,
        null,
        {
          params: { timestamp, signature: sig },
          headers: { "X-MBX-APIKEY": apiKey },
        },
      );

      const listenKey = listenKeyData.listenKey;
      if (!listenKey) {
        throw new Error("Binance returned no listenKey.");
      }

      this.binanceListenKeys.set(wsConn.connectionId, listenKey);

      // 2. Connect to user data stream
      const ws = new WebSocket(`${wsUrl}/ws/${listenKey}`);
      wsConn.ws = ws;

      ws.on("open", () => {
        console.log(
          `[TradeMonitor][Binance] WS connected for user ${wsConn.userId}`,
        );
        wsConn.isConnected = true;
        wsConn.reconnectAttempts = 0;

        // Keep listenKey alive every 30 minutes
        const refreshTimer = setInterval(async () => {
          try {
            const { data: td } = await http.get(`${baseUrl}/fapi/v1/time`);
            const ts = td.serverTime as number;
            const q = `timestamp=${ts}`;
            const s = crypto
              .createHmac("sha256", apiSecret)
              .update(q)
              .digest("hex");

            await http.put(`${baseUrl}/fapi/v1/listenKey`, null, {
              params: { timestamp: ts, signature: s },
              headers: { "X-MBX-APIKEY": apiKey },
            });
          } catch (err: any) {
            console.error(
              "[TradeMonitor][Binance] Failed to refresh listenKey:",
              err,
            );
          }
        }, BINANCE_LISTENKEY_REFRESH_MS);

        this.binanceListenKeyTimers.set(wsConn.connectionId, refreshTimer);
      });

      ws.on("message", async (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());
          await this.handleBinanceMessage(wsConn, msg);
        } catch (err: any) {
          console.error(
            "[TradeMonitor][Binance] Error processing message:",
            err,
          );
        }
      });

      ws.on("error", (err) => {
        console.error("[TradeMonitor][Binance] WS error:", err);
      });

      ws.on("close", () => {
        console.log(
          `[TradeMonitor][Binance] WS disconnected for user ${wsConn.userId}`,
        );
        wsConn.isConnected = false;
        wsConn.ws = null;

        // Clean up listenKey timer
        const timer = this.binanceListenKeyTimers.get(wsConn.connectionId);
        if (timer) {
          clearInterval(timer);
          this.binanceListenKeyTimers.delete(wsConn.connectionId);
        }

        // Reconnect if there are still active trades
        if (wsConn.activeTrades.size > 0) {
          this.scheduleReconnect(wsConn, () => this.connectBinance(wsConn));
        }
      });
    } catch (err: any) {
      console.error("[TradeMonitor][Binance] Connection error:", err);
      if (wsConn.activeTrades.size > 0) {
        this.scheduleReconnect(wsConn, () => this.connectBinance(wsConn));
      }
    }
  }

  private async handleBinanceMessage(
    wsConn: ExchangeWsConnection,
    msg: any,
  ): Promise<void> {
    // Binance Futures user data stream event types
    if (msg.e !== "ORDER_TRADE_UPDATE") return;

    const order = msg.o;
    if (!order) return;

    const orderId = String(order.i);
    const monitored = wsConn.activeTrades.get(orderId);

    if (!monitored) return;

    const statusMap: Record<string, string> = {
      NEW: "pending",
      PARTIALLY_FILLED: "pending",
      FILLED: "filled",
      CANCELED: "cancelled",
      REJECTED: "failed",
      EXPIRED: "cancelled",
    };

    const newStatus = statusMap[order.X] || "pending";
    const filledPrice = order.ap || order.L || null; // average price or last fill price

    // Emit real-time update to frontend
    this.emit("tradeUpdate", {
      tradeId: monitored.tradeId,
      exchangeOrderId: orderId,
      exchange: "binance",
      status: newStatus,
      filledPrice,
      filledQuantity: order.z || null,
      timestamp: new Date(order.T || Date.now()),
    });

    // Update trade in DB
    const update: Record<string, unknown> = {
      lastCheckedAt: new Date(),
    };

    if (newStatus === "filled") {
      update.status = "filled";
      update.entryFillPrice = filledPrice;
      console.log(
        `[TradeMonitor][Binance] Trade ${monitored.tradeId} entry FILLED at ${filledPrice}`,
      );
    } else if (newStatus === "cancelled" || newStatus === "failed") {
      update.status = newStatus;
      update.wsMonitoringActive = false;
      wsConn.activeTrades.delete(orderId);
      console.log(
        `[TradeMonitor][Binance] Trade ${monitored.tradeId} ${newStatus}`,
      );
    }

    await Trade.updateOne({ _id: monitored.tradeId }, { $set: update });

    // Check for position closure (TP/SL orders hitting)
    // Binance sends separate ORDER_TRADE_UPDATE events for TP/SL orders
    if (
      newStatus === "filled" &&
      (order.ot === "TAKE_PROFIT_MARKET" || order.ot === "STOP_MARKET")
    ) {
      const closedVia = order.ot === "TAKE_PROFIT_MARKET" ? "tp" : "sl";
      const exitPrice = filledPrice || order.ap || order.p;

      // Find the original trade by symbol
      let originalTrade: MonitoredTrade | undefined;
      for (const [, t] of wsConn.activeTrades) {
        const normalizedPair = t.pair.replace(/\//g, "").toUpperCase();
        if (normalizedPair === order.s) {
          originalTrade = t;
          break;
        }
      }

      if (originalTrade && exitPrice) {
        try {
          const result = await processTradeClose(
            originalTrade.tradeId,
            exitPrice,
            closedVia as "tp" | "sl",
          );

          this.emit("tradeClosed", result);
          wsConn.activeTrades.delete(originalTrade.exchangeOrderId);
          console.log(
            `[TradeMonitor][Binance] Trade ${originalTrade.tradeId} closed via ${closedVia}`,
          );

          if (wsConn.activeTrades.size === 0) {
            const connKey = `${wsConn.userId}_${wsConn.exchange}`;
            this.closeConnection(connKey);
          }
        } catch (err: any) {
          console.error(
            `[TradeMonitor][Binance] Error processing trade close:`,
            err,
          );
        }
      }
    }
  }

  // ─── Bitget Futures WebSocket ───────────────────────────────────────────

  private async connectBitget(wsConn: ExchangeWsConnection): Promise<void> {
    const { apiKey, apiSecret, passphrase } = wsConn.credentials;
    if (!passphrase) {
      console.error("[TradeMonitor][Bitget] Passphrase is required.");
      return;
    }

    const wsUrl =
      process.env.BITGET_WS_URL || "wss://ws.bitget.com/v2/ws/private";

    try {
      const ws = new WebSocket(wsUrl);
      wsConn.ws = ws;

      ws.on("open", () => {
        console.log(
          `[TradeMonitor][Bitget] WS connected for user ${wsConn.userId}`,
        );
        wsConn.isConnected = true;
        wsConn.reconnectAttempts = 0;

        // Authenticate
        this.authenticateBitget(wsConn);

        // Ping keepalive
        wsConn.keepaliveTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send("ping");
          }
        }, BITGET_PING_INTERVAL_MS);
      });

      ws.on("message", async (data: WebSocket.Data) => {
        try {
          const rawMsg = data.toString();

          // Handle pong
          if (rawMsg === "pong") return;

          const msg = JSON.parse(rawMsg);
          await this.handleBitgetMessage(wsConn, msg);
        } catch (err: any) {
          console.error(
            "[TradeMonitor][Bitget] Error processing message:",
            err,
          );
        }
      });

      ws.on("error", (err) => {
        console.error("[TradeMonitor][Bitget] WS error:", err);
      });

      ws.on("close", () => {
        console.log(
          `[TradeMonitor][Bitget] WS disconnected for user ${wsConn.userId}`,
        );
        wsConn.isConnected = false;
        wsConn.ws = null;

        if (wsConn.keepaliveTimer) {
          clearInterval(wsConn.keepaliveTimer);
          wsConn.keepaliveTimer = null;
        }

        if (wsConn.activeTrades.size > 0) {
          this.scheduleReconnect(wsConn, () => this.connectBitget(wsConn));
        }
      });
    } catch (err: any) {
      console.error("[TradeMonitor][Bitget] Connection error:", err);
      if (wsConn.activeTrades.size > 0) {
        this.scheduleReconnect(wsConn, () => this.connectBitget(wsConn));
      }
    }
  }

  private authenticateBitget(wsConn: ExchangeWsConnection): void {
    const { apiKey, apiSecret, passphrase } = wsConn.credentials;
    if (!wsConn.ws || wsConn.ws.readyState !== WebSocket.OPEN) return;

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signPayload = timestamp + "GET" + "/user/verify";
    const signature = crypto
      .createHmac("sha256", apiSecret)
      .update(signPayload)
      .digest("base64");

    const authMsg = {
      op: "login",
      args: [
        {
          apiKey,
          passphrase,
          timestamp,
          sign: signature,
        },
      ],
    };

    wsConn.ws.send(JSON.stringify(authMsg));
  }

  private subscribeBitgetOrders(wsConn: ExchangeWsConnection): void {
    if (!wsConn.ws || wsConn.ws.readyState !== WebSocket.OPEN) return;

    const subscribeMsg = {
      op: "subscribe",
      args: [
        {
          instType: "USDT-FUTURES",
          channel: "orders",
          instId: "default",
        },
      ],
    };

    wsConn.ws.send(JSON.stringify(subscribeMsg));
    console.log("[TradeMonitor][Bitget] Subscribed to orders channel");
  }

  private async handleBitgetMessage(
    wsConn: ExchangeWsConnection,
    msg: any,
  ): Promise<void> {
    // Handle login response
    if (msg.event === "login") {
      if (msg.code === 0 || msg.code === "0") {
        console.log("[TradeMonitor][Bitget] Authenticated successfully");
        this.subscribeBitgetOrders(wsConn);
      } else {
        console.error(
          "[TradeMonitor][Bitget] Authentication failed:",
          msg.msg,
        );
      }
      return;
    }

    // Handle subscription confirmation
    if (msg.event === "subscribe") {
      console.log("[TradeMonitor][Bitget] Subscription confirmed:", msg.arg);
      return;
    }

    // Handle order updates
    if (msg.action === "snapshot" || msg.action === "update") {
      if (!msg.data || !Array.isArray(msg.data)) return;

      for (const order of msg.data) {
        const orderId = order.ordId || order.orderId;
        if (!orderId) continue;

        const monitored = wsConn.activeTrades.get(orderId);
        if (!monitored) continue;

        const statusMap: Record<string, string> = {
          live: "pending",
          new: "pending",
          partially_filled: "pending",
          partial_fill: "pending",
          filled: "filled",
          full_fill: "filled",
          cancelled: "cancelled",
          canceled: "cancelled",
        };

        const rawStatus = (order.status || order.state || "").toLowerCase();
        const newStatus = statusMap[rawStatus] || "pending";
        const filledPrice = order.avgPx || order.priceAvg || null;

        // Emit real-time update
        this.emit("tradeUpdate", {
          tradeId: monitored.tradeId,
          exchangeOrderId: orderId,
          exchange: "bitget",
          status: newStatus,
          filledPrice,
          filledQuantity: order.accBaseVolume || order.fillSz || null,
          timestamp: new Date(
            parseInt(order.uTime || order.cTime || String(Date.now())),
          ),
        });

        // Update DB
        const update: Record<string, unknown> = {
          lastCheckedAt: new Date(),
        };

        if (newStatus === "filled") {
          // Check if this is the entry order or a TP/SL closure
          const tradeSide = order.tradeSide || order.posSide || "";

          if (tradeSide === "close" || order.reduceOnly === true) {
            // This is a position closure (TP or SL hit)
            const exitPrice = filledPrice || order.price;
            const triggerPrice = parseFloat(order.triggerPrice || "0");
            const tp = parseFloat(monitored.tp);
            const sl = parseFloat(monitored.sl);

            // Determine if TP or SL based on trigger price proximity
            let closedVia: "tp" | "sl" | "manual" = "manual";
            if (triggerPrice > 0) {
              const distToTp = Math.abs(triggerPrice - tp);
              const distToSl = Math.abs(triggerPrice - sl);
              closedVia = distToTp < distToSl ? "tp" : "sl";
            }

            if (exitPrice) {
              try {
                const result = await processTradeClose(
                  monitored.tradeId,
                  exitPrice,
                  closedVia,
                );

                this.emit("tradeClosed", result);
                wsConn.activeTrades.delete(orderId);
                console.log(
                  `[TradeMonitor][Bitget] Trade ${monitored.tradeId} closed via ${closedVia}`,
                );

                if (wsConn.activeTrades.size === 0) {
                  const connKey = `${wsConn.userId}_${wsConn.exchange}`;
                  this.closeConnection(connKey);
                }
              } catch (err: any) {
                console.error(
                  `[TradeMonitor][Bitget] Error processing trade close:`,
                  err,
                );
              }
            }
          } else {
            // Entry order filled
            update.status = "filled";
            update.entryFillPrice = filledPrice;
            console.log(
              `[TradeMonitor][Bitget] Trade ${monitored.tradeId} entry FILLED at ${filledPrice}`,
            );
          }
        } else if (newStatus === "cancelled" || newStatus === "failed") {
          update.status = newStatus;
          update.wsMonitoringActive = false;
          wsConn.activeTrades.delete(orderId);
          console.log(
            `[TradeMonitor][Bitget] Trade ${monitored.tradeId} ${newStatus}`,
          );
        }

        await Trade.updateOne({ _id: monitored.tradeId }, { $set: update });
      }
    }
  }

  // ─── Connection Management ──────────────────────────────────────────────

  private closeConnection(connKey: string): void {
    const wsConn = this.connections.get(connKey);
    if (!wsConn) return;

    if (wsConn.reconnectTimer) {
      clearTimeout(wsConn.reconnectTimer);
      wsConn.reconnectTimer = null;
    }

    if (wsConn.keepaliveTimer) {
      clearInterval(wsConn.keepaliveTimer);
      wsConn.keepaliveTimer = null;
    }

    if (wsConn.ws) {
      wsConn.ws.close();
      wsConn.ws = null;
    }

    wsConn.isConnected = false;
    this.connections.delete(connKey);

    console.log(`[TradeMonitor] Closed connection ${connKey}`);
  }

  private scheduleReconnect(
    wsConn: ExchangeWsConnection,
    connectFn: () => Promise<void>,
  ): void {
    if (wsConn.reconnectTimer) return;
    if (wsConn.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error(
        `[TradeMonitor] Max reconnect attempts reached for ${wsConn.exchange} user ${wsConn.userId}`,
      );
      return;
    }

    const delay = Math.min(
      1000 * Math.pow(2, wsConn.reconnectAttempts),
      MAX_RECONNECT_DELAY_MS,
    );

    console.log(
      `[TradeMonitor][${wsConn.exchange}] Reconnecting in ${delay}ms (attempt ${wsConn.reconnectAttempts + 1})`,
    );

    wsConn.reconnectTimer = setTimeout(async () => {
      wsConn.reconnectTimer = null;
      wsConn.reconnectAttempts++;
      try {
        await connectFn();
      } catch (err: any) {
        console.error(
          `[TradeMonitor][${wsConn.exchange}] Reconnect failed:`,
          err,
        );
      }
    }, delay);
  }

  // ─── Status ─────────────────────────────────────────────────────────────

  getActiveMonitorCount(): number {
    let count = 0;
    for (const [, wsConn] of this.connections) {
      count += wsConn.activeTrades.size;
    }
    return count;
  }

  getConnectionStatus(): Array<{
    exchange: ExchangeId;
    userId: string;
    isConnected: boolean;
    activeTradeCount: number;
  }> {
    const result: Array<{
      exchange: ExchangeId;
      userId: string;
      isConnected: boolean;
      activeTradeCount: number;
    }> = [];

    for (const [, wsConn] of this.connections) {
      result.push({
        exchange: wsConn.exchange,
        userId: wsConn.userId,
        isConnected: wsConn.isConnected,
        activeTradeCount: wsConn.activeTrades.size,
      });
    }

    return result;
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let instance: TradeMonitorService | null = null;

export function getTradeMonitorService(): TradeMonitorService {
  if (!instance) {
    instance = new TradeMonitorService();
  }
  return instance;
}
