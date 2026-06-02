import { Router } from "express";
import {
  initiateTrade,
  refreshTradeStatus,
  getUserTrades,
  getTradeById,
  fetchExchangeBalances,
} from "../controllers/tradeController.js";
import {
  userAuthenticate,
  requireRole,
} from "../middleware/authenticationMiddleware.js";

const tradeRouter = Router();

// All trade routes require authentication
tradeRouter.use(userAuthenticate);
tradeRouter.use(requireRole(["CopyTrader"]));

// Initiates a copy trade for the authenticated user:
tradeRouter.post("/", initiateTrade);

// GET User Trades
tradeRouter.get("/", getUserTrades);

// GET User exchange balances for all connected accounts
tradeRouter.get("/balances", fetchExchangeBalances);

// Returns a single trade with populated signal and exchange connection info.
tradeRouter.get("/:tradeId", getTradeById);

// Triggers an on-demand status check for an open trade against the exchange.
tradeRouter.post("/:tradeId/refresh", refreshTradeStatus);

export default tradeRouter;
