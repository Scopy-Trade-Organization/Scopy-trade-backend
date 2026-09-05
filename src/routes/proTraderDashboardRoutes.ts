import { Router } from "express";
import {
  userAuthenticate,
  requireRole,
} from "../middleware/authenticationMiddleware.js";
import {
  withdrawFunds,
  saveWalletAddress,
  getWalletAddress,
  getWithdrawalHistory,
  getProTrades,
  updateProTrade,
  closeProTrade,
  requestWithdrawalOtp,
  getProTradeCopiers,
} from "../controllers/proTraderDashboardController.js";
import { initiateTrade } from "../controllers/tradeController.js";

const proTraderDashboardRouter = Router();

// authentication and role-based access control middleware
proTraderDashboardRouter.use(userAuthenticate);
proTraderDashboardRouter.use(requireRole(["ProTrader"]));

proTraderDashboardRouter.post("/wallet", saveWalletAddress);
proTraderDashboardRouter.get("/wallet", getWalletAddress);

proTraderDashboardRouter.post(
  "/trades",
  (_req, res, next) => {
    res.locals.tradeOrigin = "pro";
    next();
  },
  initiateTrade,
);
proTraderDashboardRouter.get("/trades", getProTrades);
proTraderDashboardRouter.get("/trades/:tradeId/copiers", getProTradeCopiers);
proTraderDashboardRouter.patch("/trades/:tradeId", updateProTrade);
proTraderDashboardRouter.post("/trades/:tradeId/close", closeProTrade);

proTraderDashboardRouter.post("/withdraw", withdrawFunds);
proTraderDashboardRouter.post("/withdraw/request-otp", requestWithdrawalOtp);
proTraderDashboardRouter.get("/withdraw/history", getWithdrawalHistory);

export default proTraderDashboardRouter;
