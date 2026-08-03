import { Router } from "express";
import {
  initiateTrade,
  getUserTrades,
  getTradeById,
  fetchExchangeBalances,
  previewTrade,
} from "../controllers/tradeController.js";
import {
  userAuthenticate,
  requireRole,
} from "../middleware/authenticationMiddleware.js";

const tradeRouter = Router();

// All trade routes require authentication
tradeRouter.use(userAuthenticate);

// Preview trade — calculates position sizing without placing an order
tradeRouter.post("/preview", requireRole(["CopyTrader"]), previewTrade);

// Initiates a copy trade for the authenticated user:
tradeRouter.post("/", requireRole(["CopyTrader"]), initiateTrade);

// GET User Trades
tradeRouter.get("/", requireRole(["CopyTrader", "Pro Trader"]), getUserTrades);

// GET User exchange balances for all connected accounts
tradeRouter.get(
  "/balances",
  requireRole(["CopyTrader", "Pro Trader"]),
  fetchExchangeBalances,
);

// Returns a single trade with populated signal and exchange connection info.
tradeRouter.get(
  "/:tradeId",
  requireRole(["CopyTrader", "Pro Trader"]),
  getTradeById,
);

export default tradeRouter;
