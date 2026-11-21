import { Router } from "express";
import {
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

tradeRouter.post("/preview", requireRole(["CopyTrader", "ProTrader"]), previewTrade);

// Legacy manual copying is replaced by trader subscriptions:
tradeRouter.post("/", requireRole(["CopyTrader"]), (_req, res) => res.status(410).json({ success: false, message: "Trades are copied automatically. Choose a pro trader from your dashboard to start copying." }));

// GET User Trades
tradeRouter.get("/", requireRole(["CopyTrader", "ProTrader"]), getUserTrades);

// GET User exchange balances for all connected accounts
tradeRouter.get(
  "/balances",
  requireRole(["CopyTrader", "ProTrader"]),
  fetchExchangeBalances,
);

// Returns a single trade with populated signal and exchange connection info.
tradeRouter.get(
  "/:tradeId",
  requireRole(["CopyTrader", "ProTrader"]),
  getTradeById,
);

export default tradeRouter;
