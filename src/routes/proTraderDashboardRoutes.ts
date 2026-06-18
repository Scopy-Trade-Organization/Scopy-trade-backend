import { Router } from "express";
import {
  userAuthenticate,
  requireRole,
} from "../middleware/authenticationMiddleware.js";
import {
  createSignal,
  deleteSignal,
  getAllSignals,
  updateSignal,
  withdrawFunds,
  saveWalletAddress,
  getWalletAddress,
} from "../controllers/proTraderDashboardController.js";

const proTraderDashboardRouter = Router();

// authentication and role-based access control middleware
proTraderDashboardRouter.use(userAuthenticate);
proTraderDashboardRouter.use(requireRole(["Pro Trader"]));

proTraderDashboardRouter.post("/wallet", saveWalletAddress);
proTraderDashboardRouter.get("/wallet", getWalletAddress);

proTraderDashboardRouter.post("/signals", createSignal);

proTraderDashboardRouter.get("/signals", getAllSignals);

proTraderDashboardRouter.delete("/signals/:signalId", deleteSignal);

proTraderDashboardRouter.patch("/signals/:signalId", updateSignal);

proTraderDashboardRouter.post("/withdraw", withdrawFunds);

export default proTraderDashboardRouter;
