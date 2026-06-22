// // services/websocketManager.ts
// import WebSocket from "ws";
// import { EventEmitter } from "events";
// import { decryptCredentials } from "./exchangeConnectionService.js";
// import { ExchangeConnection } from "../models/exchangeConnectionModel.js";
// import { Trade } from "../models/tradeModel.js";
// import { ExchangeId } from "../types/index.js";
// import mongoose from "mongoose";

// // ─── Types ──────────────────────────────────────────────────────────────

// export interface TradeUpdateEvent {
//   tradeId: string;
//   exchangeOrderId: string;
//   exchange: ExchangeId;
//   status: "pending" | "filled" | "closed" | "cancelled" | "failed";
//   filledPrice: string | null;
//   filledQuantity: string | null;
//   timestamp: Date;
//   raw: unknown;
// }

// export interface WebSocketConnection {
//   exchange: ExchangeId;
//   userId: mongoose.Types.ObjectId;
//   connectionId: mongoose.Types.ObjectId;
//   ws: WebSocket;
//   subscribedTopics: Set<string>;
//   credentials: {
//     apiKey: string;
//     apiSecret: string;
//     passphrase?: string;
//   };
//   reconnectAttempts: number;
//   isConnected: boolean;
// }

// // ─── Exchange-Specific WebSocket Handlers ──────────────────────────────

// interface BinanceWsMessage {
//   e: string; // event type
//   E: number; // event time
//   o: {
//     s: string; // symbol
//     i: number; // order ID
//     x: string; // execution type (NEW, FILLED, CANCELED, etc.)
//     X: string; // order status (NEW, FILLED, CANCELED, etc.)
//     p: string; // price
//     q: string; // quantity
//     z: string; // cumulative filled quantity
//     Z: string; // cumulative filled quote amount
//     L: string; // last executed price
//     n: string; // commission amount
//     N: string; // commission asset
//     T: number; // trade time
//   };
// }

// class BinanceWebSocketHandler {
//   private ws: WebSocket | null = null;
//   private reconnectTimer: NodeJS.Timeout | null = null;
//   private isConnecting = false;
//   private pingInterval: NodeJS.Timeout | null = null;

//   constructor(
//     private connection: WebSocketConnection,
//     private onUpdate: (update: TradeUpdateEvent) => Promise<void>,
//     private onDisconnect: (exchange: ExchangeId) => void,
//   ) {}

//   async connect(): Promise<void> {
//     if (this.isConnecting || this.ws?.readyState === WebSocket.OPEN) return;

//     this.isConnecting = true;
//     const baseUrl = process.env.BINANCE_WS_URL ?? "wss://fstream.binance.com";
//     // For testnet: wss://fstream.binancefuture.com

//     try {
//       this.ws = new WebSocket(`${baseUrl}/ws`);

//       this.ws.on("open", () => {
//         console.log(
//           `[Binance] WebSocket connected for user ${this.connection.userId}`,
//         );
//         this.isConnecting = false;
//         this.connection.isConnected = true;
//         this.connection.reconnectAttempts = 0;

//         // Subscribe to all order updates for this connection
//         this.subscribeToOrders();

//         // Setup ping/pong keepalive
//         this.startPingInterval();
//       });

//       this.ws.on("message", async (data: WebSocket.Data) => {
//         try {
//           const message = JSON.parse(data.toString()) as BinanceWsMessage;
//           await this.handleMessage(message);
//         } catch (err) {
//           console.error("[Binance] Error processing WebSocket message:", err);
//         }
//       });

//       this.ws.on("error", (err) => {
//         console.error("[Binance] WebSocket error:", err);
//         this.isConnecting = false;
//       });

//       this.ws.on("close", () => {
//         console.log(
//           `[Binance] WebSocket disconnected for user ${this.connection.userId}`,
//         );
//         this.connection.isConnected = false;
//         this.stopPingInterval();
//         this.onDisconnect("binance");
//         this.scheduleReconnect();
//       });
//     } catch (err) {
//       console.error("[Binance] Connection error:", err);
//       this.isConnecting = false;
//       this.scheduleReconnect();
//     }
//   }

//   private subscribeToOrders(): void {
//     // For Binance, we need to listen to order updates via user data stream
//     // First, create a listenKey
//     // Then subscribe to the user data stream
//     // This is a simplified version - in production you'd handle listenKey refresh
//     if (this.ws?.readyState === WebSocket.OPEN) {
//       // Actual subscription would be:
//       // { "method": "SUBSCRIBE", "params": ["<listenKey>"], "id": 1 }
//       // For now, we'll implement the simpler approach using the generic websocket
//       console.log("[Binance] Subscribed to order updates");
//     }
//   }

//   private startPingInterval(): void {
//     this.pingInterval = setInterval(() => {
//       if (this.ws?.readyState === WebSocket.OPEN) {
//         this.ws.send(JSON.stringify({ ping: Date.now() }));
//       }
//     }, 30000);
//   }

//   private stopPingInterval(): void {
//     if (this.pingInterval) {
//       clearInterval(this.pingInterval);
//       this.pingInterval = null;
//     }
//   }

//   private scheduleReconnect(): void {
//     if (this.reconnectTimer) return;

//     const delay = Math.min(
//       1000 * Math.pow(2, this.connection.reconnectAttempts),
//       60000,
//     );

//     console.log(
//       `[Binance] Reconnecting in ${delay}ms (attempt ${this.connection.reconnectAttempts + 1})`,
//     );

//     this.reconnectTimer = setTimeout(() => {
//       this.reconnectTimer = null;
//       this.connection.reconnectAttempts++;
//       this.connect();
//     }, delay);
//   }

//   private async handleMessage(message: BinanceWsMessage): Promise<void> {
//     // Binance user data stream events
//     if (message.e === "executionReport" || message.e === "ORDER_TRADE_UPDATE") {
//       const order = message.o || message;

//       // Find trade in database by exchangeOrderId
//       const trade = await Trade.findOne({
//         exchangeOrderId: String(order.i),
//         status: { $nin: ["filled", "cancelled", "failed"] },
//       });

//       if (!trade) return;

//       const statusMap: Record<string, TradeUpdateEvent["status"]> = {
//         NEW: "pending",
//         FILLED: "filled",
//         CANCELED: "cancelled",
//         REJECTED: "failed",
//         EXPIRED: "cancelled",
//         PARTIALLY_FILLED: "pending",
//       };

//       const update: TradeUpdateEvent = {
//         tradeId: String(trade._id),
//         exchangeOrderId: String(order.i),
//         exchange: "binance",
//         status: statusMap[order.X] || "pending",
//         filledPrice: order.L || null,
//         filledQuantity: order.z || null,
//         timestamp: new Date(order.T || Date.now()),
//         raw: message,
//       };

//       await this.onUpdate(update);
//     }
//   }

//   disconnect(): void {
//     if (this.reconnectTimer) {
//       clearTimeout(this.reconnectTimer);
//       this.reconnectTimer = null;
//     }
//     this.stopPingInterval();
//     if (this.ws) {
//       this.ws.close();
//       this.ws = null;
//     }
//     this.connection.isConnected = false;
//   }
// }

// // ─── Bybit WebSocket Handler ────────────────────────────────────────────

// interface BybitWsMessage {
//   topic: string;
//   type: "snapshot" | "delta";
//   ts: number;
//   data: {
//     orderId: string;
//     symbol: string;
//     orderStatus: string;
//     cumExecQty: string;
//     cumExecValue: string;
//     avgPrice: string;
//     status: number;
//   };
// }

// class BybitWebSocketHandler {
//   private ws: WebSocket | null = null;
//   private reconnectTimer: NodeJS.Timeout | null = null;
//   private isConnecting = false;
//   private pingInterval: NodeJS.Timeout | null = null;
//   private isAuthenticated = false;

//   constructor(
//     private connection: WebSocketConnection,
//     private onUpdate: (update: TradeUpdateEvent) => Promise<void>,
//     private onDisconnect: (exchange: ExchangeId) => void,
//   ) {}

//   async connect(): Promise<void> {
//     if (this.isConnecting || this.ws?.readyState === WebSocket.OPEN) return;

//     this.isConnecting = true;
//     const baseUrl =
//       process.env.BYBIT_WS_URL ?? "wss://stream.bybit.com/v5/public/linear";

//     try {
//       this.ws = new WebSocket(baseUrl);

//       this.ws.on("open", () => {
//         console.log(
//           `[Bybit] WebSocket connected for user ${this.connection.userId}`,
//         );
//         this.isConnecting = false;
//         this.connection.isConnected = true;
//         this.connection.reconnectAttempts = 0;

//         // Authenticate with API key
//         this.authenticate();

//         // Setup ping/pong
//         this.startPingInterval();
//       });

//       this.ws.on("message", async (data: WebSocket.Data) => {
//         try {
//           const message = JSON.parse(data.toString());

//           // Handle authentication response
//           if (message.success === true) {
//             this.isAuthenticated = true;
//             console.log("[Bybit] Authenticated successfully");
//             // Subscribe to order updates after auth
//             this.subscribeToOrders();
//             return;
//           }

//           if (message.success === false) {
//             console.error("[Bybit] Authentication failed:", message.retMsg);
//             return;
//           }

//           // Handle order updates
//           if (message.topic === "order") {
//             await this.handleOrderUpdate(message);
//           }
//         } catch (err) {
//           console.error("[Bybit] Error processing WebSocket message:", err);
//         }
//       });

//       this.ws.on("error", (err) => {
//         console.error("[Bybit] WebSocket error:", err);
//         this.isConnecting = false;
//       });

//       this.ws.on("close", () => {
//         console.log(
//           `[Bybit] WebSocket disconnected for user ${this.connection.userId}`,
//         );
//         this.connection.isConnected = false;
//         this.isAuthenticated = false;
//         this.stopPingInterval();
//         this.onDisconnect("bybit");
//         this.scheduleReconnect();
//       });
//     } catch (err) {
//       console.error("[Bybit] Connection error:", err);
//       this.isConnecting = false;
//       this.scheduleReconnect();
//     }
//   }

//   private authenticate(): void {
//     if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

//     const { apiKey, apiSecret } = this.connection.credentials;
//     const expires = Date.now() + 10000;
//     const signature = crypto
//       .createHmac("sha256", apiSecret)
//       .update(`GET/realtime${expires}`)
//       .digest("hex");

//     const authMessage = {
//       op: "auth",
//       args: [apiKey, expires, signature],
//     };

//     this.ws.send(JSON.stringify(authMessage));
//   }

//   private subscribeToOrders(): void {
//     if (
//       !this.ws ||
//       this.ws.readyState !== WebSocket.OPEN ||
//       !this.isAuthenticated
//     )
//       return;

//     const subscribeMessage = {
//       op: "subscribe",
//       args: ["order"],
//     };

//     this.ws.send(JSON.stringify(subscribeMessage));
//   }

//   private startPingInterval(): void {
//     this.pingInterval = setInterval(() => {
//       if (this.ws?.readyState === WebSocket.OPEN) {
//         this.ws.send(JSON.stringify({ op: "ping" }));
//       }
//     }, 20000);
//   }

//   private stopPingInterval(): void {
//     if (this.pingInterval) {
//       clearInterval(this.pingInterval);
//       this.pingInterval = null;
//     }
//   }

//   private scheduleReconnect(): void {
//     if (this.reconnectTimer) return;

//     const delay = Math.min(
//       1000 * Math.pow(2, this.connection.reconnectAttempts),
//       60000,
//     );

//     this.reconnectTimer = setTimeout(() => {
//       this.reconnectTimer = null;
//       this.connection.reconnectAttempts++;
//       this.connect();
//     }, delay);
//   }

//   private async handleOrderUpdate(message: BybitWsMessage): Promise<void> {
//     const order = message.data;

//     const trade = await Trade.findOne({
//       exchangeOrderId: order.orderId,
//       status: { $nin: ["filled", "cancelled", "failed"] },
//     });

//     if (!trade) return;

//     const statusMap: Record<string, TradeUpdateEvent["status"]> = {
//       Filled: "filled",
//       Cancelled: "cancelled",
//       Rejected: "failed",
//       New: "pending",
//       PartiallyFilled: "pending",
//     };

//     const update: TradeUpdateEvent = {
//       tradeId: String(trade._id),
//       exchangeOrderId: order.orderId,
//       exchange: "bybit",
//       status: statusMap[order.orderStatus] || "pending",
//       filledPrice: order.avgPrice || null,
//       filledQuantity: order.cumExecQty || null,
//       timestamp: new Date(message.ts),
//       raw: message,
//     };

//     await this.onUpdate(update);
//   }

//   disconnect(): void {
//     if (this.reconnectTimer) {
//       clearTimeout(this.reconnectTimer);
//       this.reconnectTimer = null;
//     }
//     this.stopPingInterval();
//     if (this.ws) {
//       this.ws.close();
//       this.ws = null;
//     }
//     this.connection.isConnected = false;
//     this.isAuthenticated = false;
//   }
// }

// // ─── WebSocket Manager ──────────────────────────────────────────────────

// export class WebSocketManager extends EventEmitter {
//   private connections: Map<string, WebSocketConnection> = new Map();
//   private handlers: Map<
//     string,
//     BinanceWebSocketHandler | BybitWebSocketHandler
//   > = new Map();
//   private isInitialized = false;

//   constructor() {
//     super();
//     this.setupEventListeners();
//   }

//   private setupEventListeners(): void {
//     // Listen for process shutdown to clean up
//     process.on("SIGTERM", () => this.shutdown());
//     process.on("SIGINT", () => this.shutdown());
//   }

//   async initialize(): Promise<void> {
//     if (this.isInitialized) return;

//     console.log("[WebSocketManager] Initializing...");

//     // Load all active exchange connections from database
//     const connections = await ExchangeConnection.find({
//       isActive: true,
//     }).lean();

//     console.log(
//       `[WebSocketManager] Found ${connections.length} active connections to monitor`,
//     );

//     for (const conn of connections) {
//       await this.addConnection(conn);
//     }

//     this.isInitialized = true;
//     console.log("[WebSocketManager] Initialized successfully");
//   }

//   private async addConnection(conn: any): Promise<void> {
//     const key = String(conn._id);

//     if (this.connections.has(key)) {
//       return; // Already connected
//     }

//     const storedCreds = {
//       exchange: conn.exchange as ExchangeId,
//       apiKey: conn.encryptedApiKey!,
//       apiSecret: conn.encryptedApiSecret!,
//       ...(conn.encryptedPassphrase
//         ? { passphrase: conn.encryptedPassphrase }
//         : {}),
//     };

//     const rawCreds = decryptCredentials(storedCreds);

//     const wsConnection: WebSocketConnection = {
//       exchange: conn.exchange as ExchangeId,
//       userId: conn.userId,
//       connectionId: conn._id,
//       ws: null as any,
//       subscribedTopics: new Set(),
//       credentials: {
//         apiKey: rawCreds.apiKey,
//         apiSecret: rawCreds.apiSecret,
//         passphrase: rawCreds.passphrase,
//       },
//       reconnectAttempts: 0,
//       isConnected: false,
//     };

//     this.connections.set(key, wsConnection);

//     // Create exchange-specific handler
//     let handler: BinanceWebSocketHandler | BybitWebSocketHandler;

//     switch (conn.exchange) {
//       case "binance":
//         handler = new BinanceWebSocketHandler(
//           wsConnection,
//           this.handleTradeUpdate.bind(this),
//           this.handleDisconnect.bind(this),
//         );
//         break;
//       case "bybit":
//         handler = new BybitWebSocketHandler(
//           wsConnection,
//           this.handleTradeUpdate.bind(this),
//           this.handleDisconnect.bind(this),
//         );
//         break;
//       // Add OKX and Bitget handlers here
//       default:
//         console.warn(
//           `[WebSocketManager] Unsupported exchange: ${conn.exchange}`,
//         );
//         return;
//     }

//     this.handlers.set(key, handler);
//     await handler.connect();
//   }

//   private async handleTradeUpdate(update: TradeUpdateEvent): Promise<void> {
//     try {
//       // Update the trade in database
//       const updateData: any = {
//         status: update.status,
//         ...(update.filledPrice && { filledPrice: update.filledPrice }),
//         ...(update.filledQuantity && { filledQuantity: update.filledQuantity }),
//         updatedAt: update.timestamp,
//       };

//       // If filled, also update raw response
//       if (update.status === "filled") {
//         updateData.rawOrderResponse = updateData.rawOrderResponse || {};
//         updateData.rawOrderResponse.fill = update.raw;
//       }

//       const trade = await Trade.findByIdAndUpdate(update.tradeId, updateData, {
//         new: true,
//       });

//       if (!trade) {
//         console.warn(`[WebSocketManager] Trade ${update.tradeId} not found`);
//         return;
//       }

//       // Emit event for frontend
//       this.emit("tradeUpdate", {
//         tradeId: update.tradeId,
//         status: update.status,
//         filledPrice: update.filledPrice,
//         filledQuantity: update.filledQuantity,
//         timestamp: update.timestamp,
//         trade,
//       });

//       console.log(
//         `[WebSocketManager] Trade ${update.tradeId} updated: ${update.status}`,
//       );
//     } catch (err) {
//       console.error("[WebSocketManager] Error handling trade update:", err);
//     }
//   }

//   private handleDisconnect(exchange: ExchangeId): void {
//     console.log(`[WebSocketManager] ${exchange} disconnected`);
//     // Reconnection is handled by the individual handler
//   }

//   async refreshConnection(connectionId: string): Promise<void> {
//     const key = String(connectionId);
//     const existing = this.connections.get(key);

//     if (existing) {
//       const handler = this.handlers.get(key);
//       if (handler) {
//         handler.disconnect();
//         this.handlers.delete(key);
//       }
//       this.connections.delete(key);
//     }

//     // Reload from database and reconnect
//     const conn = await ExchangeConnection.findById(connectionId).lean();
//     if (conn && conn.isActive) {
//       await this.addConnection(conn);
//     }
//   }

//   async shutdown(): Promise<void> {
//     console.log("[WebSocketManager] Shutting down...");

//     for (const [key, handler] of this.handlers) {
//       handler.disconnect();
//     }

//     this.connections.clear();
//     this.handlers.clear();
//     this.isInitialized = false;

//     console.log("[WebSocketManager] Shutdown complete");
//   }

//   // ─── Public API ──────────────────────────────────────────────────────

//   /**
//    * Get the connection status for a specific exchange connection
//    */
//   getConnectionStatus(connectionId: string): {
//     connected: boolean;
//     reconnectAttempts: number;
//   } {
//     const key = String(connectionId);
//     const conn = this.connections.get(key);

//     return {
//       connected: conn?.isConnected || false,
//       reconnectAttempts: conn?.reconnectAttempts || 0,
//     };
//   }

//   /**
//    * Get all active connections
//    */
//   getActiveConnections(): Array<{
//     connectionId: string;
//     exchange: ExchangeId;
//     isConnected: boolean;
//   }> {
//     const result: Array<{
//       connectionId: string;
//       exchange: ExchangeId;
//       isConnected: boolean;
//     }> = [];

//     for (const [key, conn] of this.connections) {
//       result.push({
//         connectionId: key,
//         exchange: conn.exchange,
//         isConnected: conn.isConnected,
//       });
//     }

//     return result;
//   }

//   /**
//    * Add a new connection (useful for real-time additions)
//    */
//   async addNewConnection(connectionId: string): Promise<void> {
//     const conn = await ExchangeConnection.findById(connectionId).lean();
//     if (conn && conn.isActive) {
//       await this.addConnection(conn);
//     }
//   }

//   /**
//    * Remove a connection (when user disables it)
//    */
//   async removeConnection(connectionId: string): Promise<void> {
//     const key = String(connectionId);
//     const handler = this.handlers.get(key);
//     if (handler) {
//       handler.disconnect();
//       this.handlers.delete(key);
//     }
//     this.connections.delete(key);
//   }
// }

// // ─── Singleton Instance ─────────────────────────────────────────────────

// let instance: WebSocketManager | null = null;

// export function getWebSocketManager(): WebSocketManager {
//   if (!instance) {
//     instance = new WebSocketManager();
//   }
//   return instance;
// }
