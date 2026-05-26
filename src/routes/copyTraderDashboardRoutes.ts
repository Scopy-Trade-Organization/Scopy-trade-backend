/**
 * routes/copyTraderDashboardRoutes.ts
 * Mount at: /api/copy-trader-dashboard
 */

import { Router } from "express";
import {
  userAuthenticate,
  requireRole,
} from "../middleware/authenticationMiddleware.js";
import {
  getSignalById,
  getActiveSignals,
} from "../controllers/copyTraderDashboardController.js";

const copyTraderDashboardRouter = Router();

// All signal routes require authentication
copyTraderDashboardRouter.use(userAuthenticate);
copyTraderDashboardRouter.use(requireRole(["CopyTrader"]));

/**
 * GET /api/signals/active
 * Lists all active signals; includes the requesting user's trade status
 * for each signal so the UI can show "already copying" state.
 */
copyTraderDashboardRouter.get("/active", getActiveSignals);

/**
 * GET /api/signals/:signalId
 * Returns a single signal by ID.
 */
copyTraderDashboardRouter.get("/:signalId", getSignalById);

export default copyTraderDashboardRouter;
