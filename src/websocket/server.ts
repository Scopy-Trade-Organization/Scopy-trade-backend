// // websocket/server.ts
// import WebSocket from "ws";
// import { Server as HttpServer } from "http";
// import { parse } from "url";
// import { getWebSocketManager } from "../services/websocketManager.js";
// import { verifyToken } from "../services/authService.js";
// import { Trade } from "../models/tradeModel.js";
// import mongoose from "mongoose";

// interface WebSocketClient {
//   ws: WebSocket;
//   userId: mongoose.Types.ObjectId;
//   isAuthenticated: boolean;
//   subscribedTrades: Set<string>;
//   subscribedConnections: Set<string>;
// }

// export class WebSocketServer {
//   private wss: WebSocket.Server;
//   private clients: Map<string, WebSocketClient> = new Map();
//   private manager = getWebSocketManager();

//   constructor(server: HttpServer) {
//     this.wss = new WebSocket.Server({
//       server,
//       path: "/ws/trades",
//     });

//     this.setupWebSocketServer();
//     this.setupTradeUpdateListener();
//   }

//   private setupWebSocketServer(): void {
//     this.wss.on("connection", async (ws: WebSocket, req) => {
//       const query = parse(req.url || "", true).query;
//       const token = query.token as string;

//       // Authenticate the user
//       let userId: mongoose.Types.ObjectId | null = null;

//       try {
//         const decoded = await verifyToken(token);
//         userId = decoded.userId;
//       } catch (err) {
//         ws.send(
//           JSON.stringify({
//             type: "error",
//             code: "UNAUTHORIZED",
//             message: "Invalid or missing authentication token",
//           }),
//         );
//         ws.close();
//         return;
//       }

//       if (!userId) {
//         ws.send(
//           JSON.stringify({
//             type: "error",
//             code: "UNAUTHORIZED",
//             message: "Authentication required",
//           }),
//         );
//         ws.close();
//         return;
//       }

//       const clientId = String(userId);

//       // Close existing connection for this user if any
//       if (this.clients.has(clientId)) {
//         const existing = this.clients.get(clientId);
//         if (existing) {
//           existing.ws.close(1000, "New connection established");
//         }
//       }

//       const client: WebSocketClient = {
//         ws,
//         userId,
//         isAuthenticated: true,
//         subscribedTrades: new Set(),
//         subscribedConnections: new Set(),
//       };

//       this.clients.set(clientId, client);

//       // Send initial connection status
//       ws.send(
//         JSON.stringify({
//           type: "connection",
//           status: "connected",
//           timestamp: new Date().toISOString(),
//         }),
//       );

//       // Send list of active connections
//       const connections = this.manager.getActiveConnections();
//       ws.send(
//         JSON.stringify({
//           type: "connections",
//           data: connections,
//         }),
//       );

//       console.log(`[WebSocketServer] Client connected: ${clientId}`);

//       // Handle incoming messages
//       ws.on("message", async (data: WebSocket.Data) => {
//         try {
//           const message = JSON.parse(data.toString());
//           await this.handleClientMessage(client, message);
//         } catch (err) {
//           console.error("[WebSocketServer] Error handling message:", err);
//           ws.send(
//             JSON.stringify({
//               type: "error",
//               code: "INVALID_MESSAGE",
//               message: "Invalid message format",
//             }),
//           );
//         }
//       });

//       ws.on("close", () => {
//         this.clients.delete(clientId);
//         console.log(`[WebSocketServer] Client disconnected: ${clientId}`);
//       });

//       ws.on("error", (err) => {
//         console.error(`[WebSocketServer] Client error ${clientId}:`, err);
//         this.clients.delete(clientId);
//       });
//     });

//     console.log("[WebSocketServer] WebSocket server initialized on /ws/trades");
//   }

//   private setupTradeUpdateListener(): void {
//     this.manager.on("tradeUpdate", (data) => {
//       // Broadcast to all clients connected to this trade
//       this.broadcastTradeUpdate(data);
//     });
//   }

//   private async handleClientMessage(
//     client: WebSocketClient,
//     message: any,
//   ): Promise<void> {
//     const { type, data } = message;

//     switch (type) {
//       case "subscribe_trade":
//         await this.subscribeTrade(client, data);
//         break;

//       case "subscribe_connection":
//         await this.subscribeConnection(client, data);
//         break;

//       case "unsubscribe_trade":
//         this.unsubscribeTrade(client, data);
//         break;

//       case "unsubscribe_connection":
//         this.unsubscribeConnection(client, data);
//         break;

//       case "get_trade_history":
//         await this.sendTradeHistory(client, data);
//         break;

//       default:
//         throw new Error(`Unknown message type: ${type}`);
//     }
//   }

//   private async subscribeTrade(
//     client: WebSocketClient,
//     tradeId: string,
//   ): Promise<void> {
//     if (!tradeId) return;

//     // Verify the trade belongs to this user
//     const trade = await Trade.findOne({
//       _id: tradeId,
//       userId: client.userId,
//     }).lean();

//     if (!trade) {
//       client.ws.send(
//         JSON.stringify({
//           type: "error",
//           code: "NOT_FOUND",
//           message: "Trade not found or access denied",
//         }),
//       );
//       return;
//     }

//     client.subscribedTrades.add(tradeId);

//     // Send current state immediately
//     client.ws.send(
//       JSON.stringify({
//         type: "trade_state",
//         data: {
//           tradeId,
//           status: trade.status,
//           filledPrice: trade.filledPrice,
//           filledQuantity: trade.filledQuantity,
//           updatedAt: trade.updatedAt,
//         },
//       }),
//     );
//   }

//   private async subscribeConnection(
//     client: WebSocketClient,
//     connectionId: string,
//   ): Promise<void> {
//     if (!connectionId) return;

//     // Verify connection belongs to this user
//     // (Would need to check in database)
//     client.subscribedConnections.add(connectionId);

//     const status = this.manager.getConnectionStatus(connectionId);
//     client.ws.send(
//       JSON.stringify({
//         type: "connection_status",
//         data: {
//           connectionId,
//           ...status,
//         },
//       }),
//     );
//   }

//   private unsubscribeTrade(client: WebSocketClient, tradeId: string): void {
//     client.subscribedTrades.delete(tradeId);
//   }

//   private unsubscribeConnection(
//     client: WebSocketClient,
//     connectionId: string,
//   ): void {
//     client.subscribedConnections.delete(connectionId);
//   }

//   private async sendTradeHistory(
//     client: WebSocketClient,
//     filters: any,
//   ): Promise<void> {
//     const { limit = 50, status } = filters || {};

//     const trades = await Trade.find({
//       userId: client.userId,
//       ...(status && { status }),
//     })
//       .sort({ createdAt: -1 })
//       .limit(Math.min(limit, 100))
//       .lean();

//     client.ws.send(
//       JSON.stringify({
//         type: "trade_history",
//         data: trades,
//       }),
//     );
//   }

//   private broadcastTradeUpdate(data: any): void {
//     const message = JSON.stringify({
//       type: "trade_update",
//       data,
//     });

//     // Send to all clients that are subscribed to this trade
//     for (const [clientId, client] of this.clients) {
//       if (client.subscribedTrades.has(data.tradeId)) {
//         client.ws.send(message);
//       }
//     }
//   }

//   public broadcast(message: any): void {
//     const serialized = JSON.stringify(message);
//     for (const [clientId, client] of this.clients) {
//       if (client.ws.readyState === WebSocket.OPEN) {
//         client.ws.send(serialized);
//       }
//     }
//   }

//   public shutdown(): void {
//     console.log("[WebSocketServer] Shutting down...");

//     for (const [clientId, client] of this.clients) {
//       client.ws.close(1000, "Server shutting down");
//     }

//     this.clients.clear();
//     this.wss.close();
//   }
// }
