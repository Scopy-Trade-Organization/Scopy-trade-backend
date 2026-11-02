import { Router } from "express";
import { discoverTraders, getTraderProfile, startCopying, stopCopying, mySubscriptions, notifications, readNotification } from "../controllers/traderFlowController.js";
import rateLimit from "express-rate-limit";
import {
  userAuthenticate,
  requireRole,
} from "../middleware/authenticationMiddleware.js";
import {
  approveProfitShare,
  getProfitShare,
} from "../controllers/copyTraderDashboardController.js";

const copyTraderDashboardRouter = Router();

// Trader discovery and subscriptions require an authenticated copy trader.
copyTraderDashboardRouter.use(userAuthenticate);
copyTraderDashboardRouter.use(requireRole(["CopyTrader"]));

const copyLimit = rateLimit({ windowMs: 60_000, limit: 20 });
copyTraderDashboardRouter.get("/traders", discoverTraders);
copyTraderDashboardRouter.get("/traders/:traderId", getTraderProfile);
copyTraderDashboardRouter.post("/traders/:traderId/copy", copyLimit, startCopying);
copyTraderDashboardRouter.delete("/traders/:traderId/copy", stopCopying);
copyTraderDashboardRouter.get("/subscriptions", mySubscriptions);
copyTraderDashboardRouter.get("/notifications", notifications);
copyTraderDashboardRouter.patch("/notifications/:id/read", readNotification);
copyTraderDashboardRouter.get("/profit-share", getProfitShare);
copyTraderDashboardRouter.post("/profit-share/approve", approveProfitShare);

export default copyTraderDashboardRouter;
