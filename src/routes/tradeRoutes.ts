/**
 * routes/tradeRoutes.ts
 * Mount at: /api/trades
 */

import { Router } from "express";
import {
  initiateTrade,
  refreshTradeStatus,
  getUserTrades,
  getTradeById,
} from "../controllers/tradeController.js";
import {
  userAuthenticate,
  requireRole,
} from "../middleware/authenticationMiddleware.js";

const router = Router();

// All trade routes require authentication
router.use(userAuthenticate);
router.use(requireRole(["CopyTrader"]));

/**
 * POST /api/trades
 * Body: { signalId, exchangeConnectionId, quantity }
 *
 * Initiates a copy trade for the authenticated user:
 *  - Validates the signal is active
 *  - Validates the exchange connection belongs to the user
 *  - Prevents duplicate trades (same signal + same connection)
 *  - Places the order on the exchange with TP and SL
 *  - Persists the trade record
 */
router.post("/", initiateTrade);

/**
 * GET /api/trades
 * Query: ?status=open|closed|cancelled|failed&page=1&limit=20
 *
 * Returns paginated list of the user's trades.
 */
router.get("/", getUserTrades);

/**
 * GET /api/trades/:tradeId
 * Returns a single trade with populated signal and exchange connection info.
 */
router.get("/:tradeId", getTradeById);

/**
 * POST /api/trades/:tradeId/refresh
 * Triggers an on-demand status check for an open trade against the exchange.
 * The background polling job (tradeStatusJob.ts) also does this automatically
 * every 2 minutes, so this is for user-initiated refreshes only.
 */
router.post("/:tradeId/refresh", refreshTradeStatus);

export default router;
