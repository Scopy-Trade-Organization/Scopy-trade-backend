import { Router } from "express";
import {
  userAuthenticate,
  requireRole,
} from "../middleware/authenticationMiddleware.js";
import {
  withdrawFunds,
  saveWalletAddress,
  getWalletAddress,
  getProTrades,
  updateProTrade,
} from "../controllers/proTraderDashboardController.js";
import { initiateTrade } from "../controllers/tradeController.js";

const proTraderDashboardRouter = Router();

// authentication and role-based access control middleware
proTraderDashboardRouter.use(userAuthenticate);
proTraderDashboardRouter.use(requireRole(["Pro Trader"]));

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
proTraderDashboardRouter.patch("/trades/:tradeId", updateProTrade);

proTraderDashboardRouter.post("/withdraw", withdrawFunds);

export default proTraderDashboardRouter;
