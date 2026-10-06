import {
  withdrawFunds,
  saveWalletAddress,
  getWalletAddress,
  requestWithdrawalOtp,
  requestWalletOtp,
  getWithdrawalRequest,
  getFinanceSummary,
  grantDemoFunds,
  getEarnings,
  getWithdrawals,
  financeLimit,
} from "../controllers/proFinanceController.js";
import { Router } from "express";
import {
  userAuthenticate,
  requireRole,
} from "../middleware/authenticationMiddleware.js";
import {
  getProTrades,
  updateProTrade,
  closeProTrade,
  getProTradeCopiers,
} from "../controllers/proTraderDashboardController.js";
import { initiateTrade } from "../controllers/tradeController.js";

const proTraderDashboardRouter = Router();

// authentication and role-based access control middleware
proTraderDashboardRouter.use(userAuthenticate);
proTraderDashboardRouter.use(requireRole(["ProTrader"]));

proTraderDashboardRouter.post("/wallet", financeLimit, saveWalletAddress);
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

proTraderDashboardRouter.post("/withdraw", financeLimit, withdrawFunds);
proTraderDashboardRouter.post(
  "/withdraw/request-otp",
  financeLimit,
  requestWithdrawalOtp,
);

proTraderDashboardRouter.post(
  "/wallet/request-otp",
  financeLimit,
  requestWalletOtp,
);
proTraderDashboardRouter.get("/finance", getFinanceSummary);
proTraderDashboardRouter.get("/earnings", getEarnings);
proTraderDashboardRouter.get("/withdrawals", getWithdrawals);

proTraderDashboardRouter.post("/demo-credit", financeLimit, grantDemoFunds);

proTraderDashboardRouter.get(
  "/withdrawals/request/:requestId",
  getWithdrawalRequest,
);

export default proTraderDashboardRouter;
