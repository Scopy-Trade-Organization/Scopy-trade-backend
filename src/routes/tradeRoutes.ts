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
tradeRouter.use(requireRole(["CopyTrader"]));

// Preview trade — calculates position sizing without placing an order
tradeRouter.post("/preview", previewTrade);

// Initiates a copy trade for the authenticated user:
tradeRouter.post("/", initiateTrade);

// GET User Trades
tradeRouter.get("/", getUserTrades);

// GET User exchange balances for all connected accounts
tradeRouter.get("/balances", fetchExchangeBalances);

// Returns a single trade with populated signal and exchange connection info.
tradeRouter.get("/:tradeId", getTradeById);

export default tradeRouter;
