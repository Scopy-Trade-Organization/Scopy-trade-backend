/**
 * tradeMonitorService.ts
 *
 * Manages per-trade WebSocket connections to exchanges for real-time monitoring.
 * Supports every exchange currently enabled for trading: Binance USD-M
 * Futures and Bybit linear futures.
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
import {
  getExchangeRestUrl,
  getExchangeWebSocketUrl,
} from "./exchangeEnvironment.js";
import { attachBinanceTpSl, getOrderStatus } from "./tradeService.js";

// ─── Types ──────────────────────────────────────────────────────────────────

interface MonitoredTrade {
  tradeId: string;
  exchangeOrderId: string;
  initialStatus: "pending" | "filled";
  exchangeClientOrderId?: string;
  pair: string;
  direction: "buy" | "sell";
  quantity: string;
  entryPrice: string;
  tp: string;
  sl: string;
  protectionOrderIds?: Set<string>;
  protectionExitTypes?: Map<string, "tp" | "sl">;
  protectionTransport?: "algo" | "legacy";
  protectionSetupStarted?: boolean;
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

type MonitoringStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "unsupported";

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_RECONNECT_DELAY_MS = 60000;
const BINANCE_LISTENKEY_REFRESH_MS = 30 * 60 * 1000; // 30 minutes
const BITGET_PING_INTERVAL_MS = 30000;
const RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000;

// ─── Trade Monitor Service ──────────────────────────────────────────────────

export class TradeMonitorService extends EventEmitter {
  private connections: Map<string, ExchangeWsConnection> = new Map();
  private binanceListenKeys: Map<string, string> = new Map(); // connectionId → listenKey
  private binanceListenKeyTimers: Map<string, NodeJS.Timeout> = new Map();
  private isShuttingDown = false;
  private reconciliationTimer: NodeJS.Timeout | null = null;
  private reconciliationRunning = false;

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
      throw new Error(`Trade ${tradeId} not found.`);
    }

    if (!trade.exchangeOrderId) {
      throw new Error(`Trade ${tradeId} has no exchange order ID.`);
    }

    const connection = await ExchangeConnection.findById(
      trade.exchangeConnectionId,
    ).lean();

    if (!connection) {
      throw new Error(`Exchange connection for trade ${tradeId} was not found.`);
    }

    const exchange = connection.exchange as ExchangeId;

    if (exchange !== "binance" && exchange !== "bybit") {
      const message = `Exchange ${exchange} is not supported for WebSocket monitoring.`;
      await Trade.updateOne(
        { _id: tradeId },
        {
          $set: {
            wsMonitoringActive: false,
            monitoringStatus: "unsupported",
            monitoringError: message,
          },
        },
      );
      throw new Error(message);
    }

    // Each saved connection has its own API credentials and therefore needs
    // its own private stream, even when a user connects two accounts on one exchange.
    const connKey = String(connection._id);

    const monitoredTrade: MonitoredTrade = {
      tradeId: String(trade._id),
      exchangeOrderId: trade.exchangeOrderId,
      initialStatus: trade.status as "pending" | "filled",
      ...(trade.exchangeClientOrderId
        ? { exchangeClientOrderId: trade.exchangeClientOrderId }
        : {}),
      pair: trade.pair,
      direction: trade.direction as "buy" | "sell",
      quantity: trade.quantity,
      entryPrice: trade.entryPrice,
      tp: trade.tp,
      sl: trade.sl,
      ...(trade.exchangeProtectionOrderIds?.length
        ? {
            protectionOrderIds: new Set(
              trade.exchangeProtectionOrderIds.map(String),
            ),
            protectionExitTypes: new Map(
              trade.exchangeProtectionOrderIds.map((orderId, index) => [
                String(orderId),
                index === 0 ? "tp" : "sl",
              ]),
            ),
          }
        : {}),
      ...(trade.exchangeProtectionOrderTransport
        ? { protectionTransport: trade.exchangeProtectionOrderTransport }
        : {}),
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
    for (const protectionOrderId of monitoredTrade.protectionOrderIds ?? []) {
      wsConn!.activeTrades.set(protectionOrderId, monitoredTrade);
    }
    await Trade.updateOne(
      { _id: tradeId },
      {
        $set: {
          wsMonitoringActive: wsConn!.isConnected,
          monitoringStatus: wsConn!.isConnected ? "connected" : "connecting",
          monitoringError: null,
        },
      },
    );

    // Connect WS if not already connected
    if (!wsConn!.isConnected && !wsConn!.ws) {
      if (exchange === "binance") {
        await this.connectBinance(wsConn!);
      } else if (exchange === "bybit") {
        await this.connectBybit(wsConn!);
      }
    }

    // Streams only deliver events produced after they connect. Reconcile once
    // so downtime cannot leave an order in a stale state; ongoing monitoring
    // remains entirely push-based.
    await this.reconcileEntryOrder(wsConn!, monitoredTrade);

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
            {
              $set: {
                wsMonitoringActive: false,
                monitoringStatus: "disconnected",
              },
            },
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

  /** Reconcile active exchange orders in case a push event was missed. */
  startBackgroundReconciliation(
    intervalMs = RECONCILIATION_INTERVAL_MS,
  ): void {
    if (this.reconciliationTimer) return;
    this.reconciliationTimer = setInterval(() => {
      void this.reconcileActiveTrades();
    }, intervalMs);
    console.log(
      `[TradeMonitor] Background reconciliation scheduled every ${intervalMs}ms`,
    );
  }

  async reconcileActiveTrades(): Promise<void> {
    if (this.reconciliationRunning || this.isShuttingDown) return;
    this.reconciliationRunning = true;
    try {
      const trades = await Trade.find({
        status: { $in: ["pending", "filled"] },
        exchangeOrderId: { $ne: null },
      }).lean();

      for (const trade of trades) {
        const tradeId = String(trade._id);
        const existing = this.findMonitoredTrade(tradeId);
        try {
          if (existing) {
            if (
              !existing.wsConn.isConnected &&
              !existing.wsConn.ws &&
              !existing.wsConn.reconnectTimer
            ) {
              if (existing.wsConn.exchange === "binance") {
                await this.connectBinance(existing.wsConn);
              } else if (existing.wsConn.exchange === "bybit") {
                await this.connectBybit(existing.wsConn);
              }
            }
            await this.reconcileEntryOrder(existing.wsConn, existing.trade);
          } else {
            await this.startMonitoring(tradeId);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await Trade.updateOne(
            { _id: trade._id },
            {
              $set: {
                wsMonitoringActive: false,
                monitoringStatus: "disconnected",
                monitoringError: message,
              },
            },
          );
          this.emit("monitoringUpdate", {
            tradeId,
            wsMonitoringActive: false,
            monitoringStatus: "disconnected",
            monitoringError: message,
          });
        }
      }
    } finally {
      this.reconciliationRunning = false;
    }
  }

  /** Graceful shutdown — close all WebSocket connections. */
  async shutdown(): Promise<void> {
    console.log("[TradeMonitor] Shutting down...");
    this.isShuttingDown = true;
    if (this.reconciliationTimer) {
      clearInterval(this.reconciliationTimer);
      this.reconciliationTimer = null;
    }

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
    const { apiKey } = wsConn.credentials;
    const baseUrl = getExchangeRestUrl("binance");
    const wsUrl = getExchangeWebSocketUrl("binance");

    try {
      // 1. Create listenKey via REST
      const { data: listenKeyData } = await http.post(
        `${baseUrl}/fapi/v1/listenKey`,
        null,
        {
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
        void this.setConnectionMonitoringState(wsConn, "connected");

        // Keep listenKey alive every 30 minutes
        const refreshTimer = setInterval(async () => {
          try {
            await http.put(`${baseUrl}/fapi/v1/listenKey`, null, {
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
          if (msg.e === "ALGO_UPDATE") {
            await this.handleBinanceAlgoMessage(wsConn, msg);
          } else {
            await this.handleBinanceMessage(wsConn, msg);
          }
        } catch (err: any) {
          console.error(
            "[TradeMonitor][Binance] Error processing message:",
            err,
          );
        }
      });

      ws.on("error", (err) => {
        console.error("[TradeMonitor][Binance] WS error:", err);
        void this.setConnectionMonitoringState(
          wsConn,
          "reconnecting",
          err instanceof Error ? err.message : String(err),
        );
      });

      ws.on("close", () => {
        console.log(
          `[TradeMonitor][Binance] WS disconnected for user ${wsConn.userId}`,
        );
        wsConn.isConnected = false;
        wsConn.ws = null;

        if (!this.isShuttingDown && wsConn.activeTrades.size > 0) {
          void this.setConnectionMonitoringState(
            wsConn,
            "reconnecting",
            "Exchange WebSocket disconnected.",
          );
        }

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
      await this.setConnectionMonitoringState(
        wsConn,
        "reconnecting",
        err instanceof Error ? err.message : String(err),
      );
      if (wsConn.activeTrades.size > 0) {
        this.scheduleReconnect(wsConn, () => this.connectBinance(wsConn));
      }
      throw err;
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
    let monitored = wsConn.activeTrades.get(orderId);
    let isProtectionOrder =
      Boolean(monitored && orderId !== monitored.exchangeOrderId) ||
      order.ot === "TAKE_PROFIT_MARKET" || order.ot === "STOP_MARKET";
    if (!monitored && isProtectionOrder) {
      const clientOrderId = String(order.c || "");
      monitored = [...wsConn.activeTrades.values()].find(
        (trade) =>
          (trade.exchangeClientOrderId &&
            (clientOrderId === `${trade.exchangeClientOrderId}_tp` ||
              clientOrderId === `${trade.exchangeClientOrderId}_sl`)) ||
          (!trade.exchangeClientOrderId &&
            trade.pair.replace(/\//g, "").toUpperCase() ===
              String(order.s || "").toUpperCase()),
      );
      if (monitored) {
        monitored.protectionTransport ??= "legacy";
        monitored.protectionOrderIds ??= new Set();
        monitored.protectionOrderIds.add(orderId);
        monitored.protectionExitTypes ??= new Map();
        monitored.protectionExitTypes.set(
          orderId,
          order.ot === "TAKE_PROFIT_MARKET" ? "tp" : "sl",
        );
        wsConn.activeTrades.set(orderId, monitored);
      }
    }
    if (!monitored) return;
    isProtectionOrder =
      isProtectionOrder || orderId !== monitored.exchangeOrderId;

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

    if (newStatus === "filled" && !isProtectionOrder) {
      update.status = "filled";
      update.entryFillPrice = filledPrice;
      await this.ensureBinanceProtection(wsConn, monitored);
      console.log(
        `[TradeMonitor][Binance] Trade ${monitored.tradeId} entry FILLED at ${filledPrice}`,
      );
    } else if (
      orderId === monitored.exchangeOrderId &&
      (newStatus === "cancelled" || newStatus === "failed")
    ) {
      update.status = newStatus;
      update.wsMonitoringActive = false;
      update.monitoringStatus = "disconnected";
      for (const [trackedOrderId, trade] of wsConn.activeTrades) {
        if (trade.tradeId === monitored.tradeId) {
          wsConn.activeTrades.delete(trackedOrderId);
        }
      }
      console.log(
        `[TradeMonitor][Binance] Trade ${monitored.tradeId} ${newStatus}`,
      );
    }

    const allowedStatuses =
      newStatus === "cancelled" || newStatus === "failed"
        ? ["pending"]
        : ["pending", "filled"];
    await Trade.updateOne(
      { _id: monitored.tradeId, status: { $in: allowedStatuses } },
      { $set: update },
    );
    if (
      orderId === monitored.exchangeOrderId &&
      (newStatus === "cancelled" || newStatus === "failed") &&
      wsConn.activeTrades.size === 0
    ) {
      this.closeConnection(wsConn.connectionId);
    }

    // Check for position closure (TP/SL orders hitting)
    // Binance sends separate ORDER_TRADE_UPDATE events for TP/SL orders
    if (
      newStatus === "filled" &&
      isProtectionOrder
    ) {
      const closedVia =
        monitored.protectionExitTypes?.get(orderId) ??
        (order.ot === "TAKE_PROFIT_MARKET" ? "tp" : "sl");
      const exitPrice = filledPrice || order.ap || order.p;

      const originalTrade = monitored;

      if (originalTrade && exitPrice) {
        try {
          const siblingProtectionIds = [
            ...(originalTrade.protectionOrderIds ?? []),
          ].filter((protectionOrderId) => protectionOrderId !== orderId);
          await Promise.allSettled(
            siblingProtectionIds.map((protectionOrderId) =>
              this.cancelBinanceOrder(
                wsConn,
                String(order.s),
                protectionOrderId,
                originalTrade.protectionTransport ?? "algo",
              ),
            ),
          );
          const result = await processTradeClose(
            originalTrade.tradeId,
            exitPrice,
            closedVia as "tp" | "sl",
          );

          this.emit("tradeClosed", result);
          for (const [trackedOrderId, trade] of wsConn.activeTrades) {
            if (trade.tradeId === originalTrade.tradeId) {
              wsConn.activeTrades.delete(trackedOrderId);
            }
          }
          console.log(
            `[TradeMonitor][Binance] Trade ${originalTrade.tradeId} closed via ${closedVia}`,
          );

          if (wsConn.activeTrades.size === 0) {
            this.closeConnection(wsConn.connectionId);
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

  private async handleBinanceAlgoMessage(
    wsConn: ExchangeWsConnection,
    msg: any,
  ): Promise<void> {
    const order = msg.o;
    if (!order) return;

    const algoId = String(order.aid || "");
    const clientAlgoId = String(order.caid || "");
    let monitored = wsConn.activeTrades.get(algoId);
    if (!monitored) {
      monitored = [...wsConn.activeTrades.values()].find(
        (trade) =>
          trade.exchangeClientOrderId &&
          (clientAlgoId === `${trade.exchangeClientOrderId}_tp` ||
            clientAlgoId === `${trade.exchangeClientOrderId}_sl`),
      );
    }
    if (!monitored) return;

    const closedVia: "tp" | "sl" =
      order.o === "TAKE_PROFIT_MARKET" ? "tp" : "sl";
    monitored.protectionOrderIds ??= new Set();
    monitored.protectionTransport = "algo";
    monitored.protectionOrderIds.add(algoId);
    monitored.protectionExitTypes ??= new Map();
    monitored.protectionExitTypes.set(algoId, closedVia);
    wsConn.activeTrades.set(algoId, monitored);

    const actualOrderId = String(order.ai || "");
    if (actualOrderId) {
      monitored.protectionExitTypes.set(actualOrderId, closedVia);
      wsConn.activeTrades.set(actualOrderId, monitored);
    }

    const algoStatus = String(order.X || "");
    const averagePrice = String(order.ap || "");
    if (
      algoStatus === "FINISHED" &&
      Number(averagePrice) > 0
    ) {
      const siblingProtectionIds = [
        ...(monitored.protectionOrderIds ?? []),
      ].filter((protectionOrderId) => protectionOrderId !== algoId);
      await Promise.allSettled(
        siblingProtectionIds.map((protectionOrderId) =>
          this.cancelBinanceOrder(
            wsConn,
            String(order.s || ""),
            protectionOrderId,
            monitored.protectionTransport ?? "algo",
          ),
        ),
      );
      const result = await processTradeClose(
        monitored.tradeId,
        averagePrice,
        closedVia,
      );
      this.emit("tradeClosed", result);
      for (const [trackedOrderId, trade] of wsConn.activeTrades) {
        if (trade.tradeId === monitored.tradeId) {
          wsConn.activeTrades.delete(trackedOrderId);
        }
      }
      if (wsConn.activeTrades.size === 0) {
        this.closeConnection(wsConn.connectionId);
      }
    } else if (
      algoStatus === "REJECTED" ||
      algoStatus === "EXPIRED"
    ) {
      console.error(
        `[TradeMonitor][Binance] ${closedVia.toUpperCase()} protection ${algoStatus.toLowerCase()} for trade ${monitored.tradeId}: ${order.rm || "no reason supplied"}`,
      );
    }
  }

  // ─── Bitget Futures WebSocket ───────────────────────────────────────────

  private async cancelBinanceOrder(
    wsConn: ExchangeWsConnection,
    symbol: string,
    protectionOrderId: string,
    transport: "algo" | "legacy",
  ): Promise<void> {
    const baseUrl = getExchangeRestUrl("binance");
    const { data: timeData } = await http.get(`${baseUrl}/fapi/v1/time`);
    const query =
      transport === "algo"
        ? new URLSearchParams({
            algoId: protectionOrderId,
            timestamp: String(timeData.serverTime),
          }).toString()
        : new URLSearchParams({
            symbol,
            orderId: protectionOrderId,
            timestamp: String(timeData.serverTime),
          }).toString();
    const signature = crypto
      .createHmac("sha256", wsConn.credentials.apiSecret)
      .update(query)
      .digest("hex");
    await http.delete(
      `${baseUrl}/fapi/v1/${transport === "algo" ? "algoOrder" : "order"}`,
      {
        params: {
          ...Object.fromEntries(new URLSearchParams(query)),
          signature,
        },
        headers: { "X-MBX-APIKEY": wsConn.credentials.apiKey },
      },
    );
  }

  private async connectBybit(wsConn: ExchangeWsConnection): Promise<void> {
    const { apiKey, apiSecret } = wsConn.credentials;
    const wsUrl = getExchangeWebSocketUrl("bybit");

    try {
      const ws = new WebSocket(wsUrl);
      wsConn.ws = ws;

      ws.on("open", () => {
        const expires = Date.now() + 10_000;
        const signature = crypto
          .createHmac("sha256", apiSecret)
          .update(`GET/realtime${expires}`)
          .digest("hex");
        ws.send(
          JSON.stringify({
            op: "auth",
            args: [apiKey, expires, signature],
          }),
        );

        wsConn.keepaliveTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ op: "ping" }));
          }
        }, 20_000);
      });

      ws.on("message", async (raw: WebSocket.Data) => {
        try {
          const message = JSON.parse(raw.toString());
          if (message.op === "auth") {
            if (!message.success) {
              console.error(
                "[TradeMonitor][Bybit] Authentication failed:",
                message.ret_msg || message.retMsg,
              );
              ws.close(1008, "Authentication failed");
              return;
            }
            wsConn.isConnected = true;
            wsConn.reconnectAttempts = 0;
            void this.setConnectionMonitoringState(wsConn, "connected");
            ws.send(
              JSON.stringify({ op: "subscribe", args: ["order.linear"] }),
            );
            return;
          }
          if (
            message.op === "subscribe" &&
            message.success === false
          ) {
            console.error(
              "[TradeMonitor][Bybit] Subscription failed:",
              message.ret_msg || message.retMsg,
            );
            ws.close(1008, "Subscription failed");
            return;
          }
          if (
            message.topic === "order.linear" &&
            Array.isArray(message.data)
          ) {
            for (const order of message.data) {
              if (order.category === "linear") {
                await this.handleBybitOrder(wsConn, order);
              }
            }
          }
        } catch (err) {
          console.error("[TradeMonitor][Bybit] Error processing message:", err);
        }
      });

      ws.on("error", (err) => {
        console.error("[TradeMonitor][Bybit] WS error:", err);
        void this.setConnectionMonitoringState(
          wsConn,
          "reconnecting",
          err instanceof Error ? err.message : String(err),
        );
      });

      ws.on("close", () => {
        console.log(
          `[TradeMonitor][Bybit] WS disconnected for user ${wsConn.userId}`,
        );
        wsConn.isConnected = false;
        wsConn.ws = null;
        if (!this.isShuttingDown && wsConn.activeTrades.size > 0) {
          void this.setConnectionMonitoringState(
            wsConn,
            "reconnecting",
            "Exchange WebSocket disconnected.",
          );
        }
        if (wsConn.keepaliveTimer) {
          clearInterval(wsConn.keepaliveTimer);
          wsConn.keepaliveTimer = null;
        }
        if (wsConn.activeTrades.size > 0) {
          this.scheduleReconnect(wsConn, () => this.connectBybit(wsConn));
        }
      });
    } catch (err) {
      console.error("[TradeMonitor][Bybit] Connection error:", err);
      await this.setConnectionMonitoringState(
        wsConn,
        "reconnecting",
        err instanceof Error ? err.message : String(err),
      );
      if (wsConn.activeTrades.size > 0) {
        this.scheduleReconnect(wsConn, () => this.connectBybit(wsConn));
      }
      throw err;
    }
  }

  private async handleBybitOrder(
    wsConn: ExchangeWsConnection,
    order: any,
  ): Promise<void> {
    const orderId = String(order.orderId || "");
    let monitored = wsConn.activeTrades.get(orderId);

    if (!monitored && order.orderStatus === "Filled") {
      const parentOrderLinkId = String(order.parentOrderLinkId || "");
      const symbol = String(order.symbol || "").toUpperCase();
      monitored = [...wsConn.activeTrades.values()].find(
        (trade) =>
          (trade.exchangeClientOrderId &&
            parentOrderLinkId === trade.exchangeClientOrderId) ||
          (!trade.exchangeClientOrderId &&
            trade.pair.replace(/\//g, "").toUpperCase() === symbol),
      );
      if (
        monitored &&
        !order.reduceOnly &&
        !order.closeOnTrigger &&
        !order.stopOrderType
      ) {
        monitored = undefined;
      }
    }
    if (!monitored) return;

    const statusMap: Record<string, string> = {
      New: "pending",
      PartiallyFilled: "pending",
      Filled: "filled",
      Cancelled: "cancelled",
      Rejected: "failed",
      Deactivated: "cancelled",
    };
    const status = statusMap[order.orderStatus] || "pending";
    const filledPrice = order.avgPrice || order.price || null;
    const isExit =
      orderId !== monitored.exchangeOrderId &&
      status === "filled" &&
      (order.reduceOnly ||
        order.closeOnTrigger ||
        order.stopOrderType === "TakeProfit" ||
        order.stopOrderType === "StopLoss");

    if (isExit && filledPrice) {
      const tpDistance = Math.abs(Number(filledPrice) - Number(monitored.tp));
      const slDistance = Math.abs(Number(filledPrice) - Number(monitored.sl));
      const closedVia =
        order.stopOrderType === "TakeProfit"
          ? "tp"
          : order.stopOrderType === "StopLoss"
            ? "sl"
            : tpDistance < slDistance
              ? "tp"
              : "sl";
      const result = await processTradeClose(
        monitored.tradeId,
        String(filledPrice),
        closedVia,
      );
      this.emit("tradeClosed", result);
      for (const [trackedOrderId, trade] of wsConn.activeTrades) {
        if (trade.tradeId === monitored.tradeId) {
          wsConn.activeTrades.delete(trackedOrderId);
        }
      }
      if (wsConn.activeTrades.size === 0) {
        this.closeConnection(wsConn.connectionId);
      }
      return;
    }

    const update: Record<string, unknown> = {
      lastCheckedAt: new Date(),
      rawStatusResponse: order,
    };
    if (status === "filled") {
      update.status = "filled";
      update.entryFillPrice = filledPrice;
    } else if (status === "cancelled" || status === "failed") {
      update.status = status;
      update.wsMonitoringActive = false;
      update.monitoringStatus = "disconnected";
      for (const [trackedOrderId, trade] of wsConn.activeTrades) {
        if (trade.tradeId === monitored.tradeId) {
          wsConn.activeTrades.delete(trackedOrderId);
        }
      }
    }
    const allowedStatuses =
      status === "cancelled" || status === "failed"
        ? ["pending"]
        : ["pending", "filled"];
    await Trade.updateOne(
      { _id: monitored.tradeId, status: { $in: allowedStatuses } },
      { $set: update },
    );
    this.emit("tradeUpdate", {
      tradeId: monitored.tradeId,
      exchangeOrderId: orderId,
      exchange: "bybit",
      status,
      filledPrice,
      filledQuantity: order.cumExecQty || null,
      timestamp: new Date(Number(order.updatedTime) || Date.now()),
    });
    if (
      (status === "cancelled" || status === "failed") &&
      wsConn.activeTrades.size === 0
    ) {
      this.closeConnection(wsConn.connectionId);
    }
  }

  private async reconcileEntryOrder(
    wsConn: ExchangeWsConnection,
    monitored: MonitoredTrade,
  ): Promise<void> {
    try {
      const result = await getOrderStatus(
        wsConn.exchange,
        wsConn.credentials,
        monitored.pair,
        monitored.exchangeOrderId,
      );
      const update: Record<string, unknown> = {
        lastCheckedAt: new Date(),
        rawStatusResponse: result.raw,
        monitoringError: null,
      };

      if (result.status === "filled") {
        update.status = "filled";
        if (result.filledPrice) {
          update.entryFillPrice = result.filledPrice;
        }
        if (wsConn.exchange === "binance") {
          await this.ensureBinanceProtection(
            wsConn,
            monitored,
            monitored.initialStatus !== "filled",
          );
          await this.reconcileBinanceProtection(wsConn, monitored);
        }
      } else if (
        result.status === "cancelled" ||
        result.status === "failed"
      ) {
        update.status = result.status;
        update.wsMonitoringActive = false;
        update.monitoringStatus = "disconnected";
        for (const [orderId, trade] of wsConn.activeTrades) {
          if (trade.tradeId === monitored.tradeId) {
            wsConn.activeTrades.delete(orderId);
          }
        }
      }

      const allowedStatuses =
        result.status === "cancelled" || result.status === "failed"
          ? ["pending"]
          : ["pending", "filled"];
      await Trade.updateOne(
        { _id: monitored.tradeId, status: { $in: allowedStatuses } },
        { $set: update },
      );
      this.emit("tradeUpdate", {
        tradeId: monitored.tradeId,
        exchangeOrderId: monitored.exchangeOrderId,
        exchange: wsConn.exchange,
        status: result.status,
        filledPrice: result.filledPrice,
        filledQuantity: null,
        timestamp: new Date(),
      });
      this.emit("monitoringUpdate", {
        tradeId: monitored.tradeId,
        wsMonitoringActive: wsConn.isConnected,
        monitoringStatus: wsConn.isConnected ? "connected" : "reconnecting",
        monitoringError: null,
        lastCheckedAt: update.lastCheckedAt,
      });

      if (wsConn.activeTrades.size === 0) {
        this.closeConnection(wsConn.connectionId);
      }
    } catch (err) {
      // A failed snapshot does not disable the live private stream.
      const message = err instanceof Error ? err.message : String(err);
      await Trade.updateOne(
        { _id: monitored.tradeId, status: { $in: ["pending", "filled"] } },
        { $set: { monitoringError: message } },
      );
      this.emit("monitoringUpdate", {
        tradeId: monitored.tradeId,
        wsMonitoringActive: wsConn.isConnected,
        monitoringStatus: wsConn.isConnected ? "connected" : "reconnecting",
        monitoringError: message,
      });
      console.error(
        `[TradeMonitor][${wsConn.exchange}] Initial reconciliation failed for trade ${monitored.tradeId}:`,
        err,
      );
    }
  }

  private async ensureBinanceProtection(
    wsConn: ExchangeWsConnection,
    monitored: MonitoredTrade,
    allowCreate = true,
  ): Promise<void> {
    if (
      monitored.protectionSetupStarted ||
      (allowCreate && (monitored.protectionOrderIds?.size ?? 0) >= 2)
    ) {
      return;
    }

    monitored.protectionSetupStarted = true;
    try {
      const existingProtection =
        await this.findBinanceProtectionOrders(wsConn, monitored);
      const existingProtectionIds = existingProtection.ids;
      if (existingProtectionIds.length >= 2) {
        monitored.protectionOrderIds = new Set(existingProtectionIds);
        monitored.protectionTransport = existingProtection.transport;
        monitored.protectionExitTypes = new Map([
          [existingProtectionIds[0]!, "tp"],
          [existingProtectionIds[1]!, "sl"],
        ]);
        for (const orderId of existingProtectionIds) {
          wsConn.activeTrades.set(orderId, monitored);
        }
        await Trade.updateOne(
          { _id: monitored.tradeId },
          {
            $set: {
              exchangeProtectionOrderIds: existingProtectionIds,
              exchangeProtectionOrderTransport:
                existingProtection.transport,
            },
          },
        );
        return;
      }

      if (!allowCreate) {
        console.warn(
          `[TradeMonitor][Binance] Trade ${monitored.tradeId} was already filled before startup but has ${existingProtectionIds.length} open protection orders; refusing to create replacement orders without a confirmed open position.`,
        );
        return;
      }

      // Recover cleanly from a previous partial TP/SL setup.
      if (existingProtectionIds.length === 1) {
        const symbol = monitored.pair.replace(/\//g, "").toUpperCase();
        await this.cancelBinanceOrder(
          wsConn,
          symbol,
          existingProtectionIds[0]!,
          existingProtection.transport,
        );
      }

      const protection = await attachBinanceTpSl({
        credentials: wsConn.credentials,
        pair: monitored.pair,
        direction: monitored.direction,
        ...(monitored.exchangeClientOrderId
          ? { clientOrderId: monitored.exchangeClientOrderId }
          : {}),
        quantity: monitored.quantity,
        entryPrice: monitored.entryPrice,
        tp: monitored.tp,
        sl: monitored.sl,
        orderId: monitored.exchangeOrderId,
      });
      monitored.protectionOrderIds = new Set([
        protection.tpOrderId,
        protection.slOrderId,
      ]);
      monitored.protectionExitTypes = new Map([
        [protection.tpOrderId, "tp"],
        [protection.slOrderId, "sl"],
      ]);
      monitored.protectionTransport = "algo";
      wsConn.activeTrades.set(protection.tpOrderId, monitored);
      wsConn.activeTrades.set(protection.slOrderId, monitored);
      await Trade.updateOne(
        { _id: monitored.tradeId },
        {
          $set: {
            exchangeProtectionOrderIds: [
              protection.tpOrderId,
              protection.slOrderId,
            ],
            exchangeProtectionOrderTransport: "algo",
          },
        },
      );
    } catch (err) {
      monitored.protectionSetupStarted = false;
      console.error(
        `[TradeMonitor][Binance] Failed to attach TP/SL for ${monitored.tradeId}:`,
        err,
      );
    }
  }

  /**
   * A user-data websocket can be disconnected at the exact moment a Binance
   * conditional order fills.  The entry-order snapshot alone cannot detect
   * that case, so inspect each persisted TP/SL algo order during reconciliation.
   */
  private async reconcileBinanceProtection(
    wsConn: ExchangeWsConnection,
    monitored: MonitoredTrade,
  ): Promise<void> {
    const protectionIds = [...(monitored.protectionOrderIds ?? [])];
    if (!protectionIds.length) return;

    const baseUrl = getExchangeRestUrl("binance");
    const { data: timeData } = await http.get(`${baseUrl}/fapi/v1/time`);

    for (const algoId of protectionIds) {
      const query = new URLSearchParams({
        algoId,
        timestamp: String(timeData.serverTime),
      }).toString();
      const signature = crypto
        .createHmac("sha256", wsConn.credentials.apiSecret)
        .update(query)
        .digest("hex");
      const { data } = await http.get(`${baseUrl}/fapi/v1/algoOrder`, {
        params: {
          ...Object.fromEntries(new URLSearchParams(query)),
          signature,
        },
        headers: { "X-MBX-APIKEY": wsConn.credentials.apiKey },
      });

      const algoStatus = String(data.algoStatus ?? data.status ?? "").toUpperCase();
      if (algoStatus !== "FINISHED") continue;

      let exitPrice = String(
        data.actualPrice ?? data.avgPrice ?? data.activatePrice ?? "",
      );
      if ((!Number.isFinite(Number(exitPrice)) || Number(exitPrice) <= 0) && data.actualOrderId) {
        const executedOrder = await getOrderStatus(
          "binance",
          wsConn.credentials,
          monitored.pair,
          String(data.actualOrderId),
        );
        exitPrice = executedOrder.filledPrice ?? "";
      }
      if (!Number.isFinite(Number(exitPrice)) || Number(exitPrice) <= 0) {
        continue;
      }

      const closedVia = monitored.protectionExitTypes?.get(algoId) ?? "manual";
      const siblingIds = protectionIds.filter((id) => id !== algoId);
      await Promise.allSettled(
        siblingIds.map((id) =>
          this.cancelBinanceOrder(wsConn, monitored.pair.replace(/\//g, ""), id, "algo"),
        ),
      );
      const result = await processTradeClose(monitored.tradeId, exitPrice, closedVia);
      this.emit("tradeClosed", result);
      for (const [trackedOrderId, trade] of wsConn.activeTrades) {
        if (trade.tradeId === monitored.tradeId) {
          wsConn.activeTrades.delete(trackedOrderId);
        }
      }
      console.log(
        `[TradeMonitor][Binance] Reconciled trade ${monitored.tradeId} closed via ${closedVia}`,
      );
      return;
    }
  }

  private async findBinanceProtectionOrders(
    wsConn: ExchangeWsConnection,
    monitored: MonitoredTrade,
  ): Promise<{ ids: string[]; transport: "algo" | "legacy" }> {
    const baseUrl = getExchangeRestUrl("binance");
    const symbol = monitored.pair.replace(/\//g, "").toUpperCase();
    const { data: timeData } = await http.get(`${baseUrl}/fapi/v1/time`);
    const query = new URLSearchParams({
      symbol,
      timestamp: String(timeData.serverTime),
    }).toString();
    const signature = crypto
      .createHmac("sha256", wsConn.credentials.apiSecret)
      .update(query)
      .digest("hex");
    const requestConfig = {
      params: {
        ...Object.fromEntries(new URLSearchParams(query)),
        signature,
      },
      headers: { "X-MBX-APIKEY": wsConn.credentials.apiKey },
    };
    const [{ data: algoData }, { data: legacyData }] = await Promise.all([
      http.get(`${baseUrl}/fapi/v1/openAlgoOrders`, requestConfig),
      http.get(`${baseUrl}/fapi/v1/openOrders`, requestConfig),
    ]);
    const algoOrders = Array.isArray(algoData)
      ? algoData
      : algoData
        ? [algoData]
        : [];
    const legacyOrders = Array.isArray(legacyData)
      ? legacyData
      : legacyData
        ? [legacyData]
        : [];
    const expectedClientIds = monitored.exchangeClientOrderId
      ? new Set([
          `${monitored.exchangeClientOrderId}_tp`,
          `${monitored.exchangeClientOrderId}_sl`,
        ])
      : null;

    const matchOrders = (orders: any[], transport: "algo" | "legacy") =>
      orders
        .filter((order: any) => {
          const orderType =
            transport === "algo" ? order.orderType : order.type;
          if (
            orderType !== "TAKE_PROFIT_MARKET" &&
            orderType !== "STOP_MARKET"
          ) {
            return false;
          }
          if (expectedClientIds) {
            const clientId =
              transport === "algo"
                ? order.clientAlgoId
                : order.clientOrderId;
            return expectedClientIds.has(String(clientId || ""));
          }
          const stopPrice = Number(
            transport === "algo" ? order.triggerPrice : order.stopPrice,
          );
          return (
            stopPrice === Number(monitored.tp) ||
            stopPrice === Number(monitored.sl)
          );
        })
        .sort((left: any, right: any) => {
          const rank = (order: any) =>
            (transport === "algo" ? order.orderType : order.type) ===
            "TAKE_PROFIT_MARKET"
              ? 0
              : 1;
          return rank(left) - rank(right);
        })
        .map((order: any) =>
          String(transport === "algo" ? order.algoId : order.orderId),
        );

    const algoIds = matchOrders(algoOrders, "algo");
    if (algoIds.length) return { ids: algoIds, transport: "algo" };
    return { ids: matchOrders(legacyOrders, "legacy"), transport: "legacy" };
  }

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
                  this.closeConnection(wsConn.connectionId);
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

  private findMonitoredTrade(tradeId: string): {
    wsConn: ExchangeWsConnection;
    trade: MonitoredTrade;
  } | null {
    for (const wsConn of this.connections.values()) {
      for (const trade of wsConn.activeTrades.values()) {
        if (trade.tradeId === tradeId) return { wsConn, trade };
      }
    }
    return null;
  }

  private async setConnectionMonitoringState(
    wsConn: ExchangeWsConnection,
    monitoringStatus: MonitoringStatus,
    monitoringError: string | null = null,
  ): Promise<void> {
    const tradeIds = [
      ...new Set(
        [...wsConn.activeTrades.values()].map((trade) => trade.tradeId),
      ),
    ];
    if (tradeIds.length === 0) return;

    const connected = monitoringStatus === "connected";
    const update: Record<string, unknown> = {
      wsMonitoringActive: connected,
      monitoringStatus,
      monitoringError,
    };
    if (connected) update.monitoringConnectedAt = new Date();

    await Trade.updateMany(
      { _id: { $in: tradeIds }, status: { $in: ["pending", "filled"] } },
      { $set: update },
    );
    for (const tradeId of tradeIds) {
      this.emit("monitoringUpdate", {
        tradeId,
        ...update,
      });
    }
  }

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
    if (
      this.isShuttingDown ||
      this.connections.get(wsConn.connectionId) !== wsConn ||
      wsConn.activeTrades.size === 0
    ) {
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
