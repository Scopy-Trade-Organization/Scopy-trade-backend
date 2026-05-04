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
} from "../controllers/ProTraderDashboardController.js";

const proTraderDashboardRouter = Router();

// authentication and role-based access control middleware
proTraderDashboardRouter.use(userAuthenticate);
proTraderDashboardRouter.use(requireRole(["Pro Trader"]));

proTraderDashboardRouter.post("/signals", createSignal);

proTraderDashboardRouter.get("/signals", getAllSignals);

proTraderDashboardRouter.delete("/signals/:id", deleteSignal);

proTraderDashboardRouter.put("/signals/:id", updateSignal);

export default proTraderDashboardRouter;
