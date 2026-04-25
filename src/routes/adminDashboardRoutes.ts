import { Router } from "express";
import {
  createSignal,
  getAllSignals,
  deleteSignal,
  updateSignal,
  updateSignalResult,
} from "../controllers/adminDashboardController.js";
import { adminAuthenticate } from "../middleware/authenticationMiddleware.js";

const adminDashboardRouter = Router();

// All routes require admin authentication
adminDashboardRouter.use(adminAuthenticate);

// POST   /api/admin/signals       — create a new trade signal
adminDashboardRouter.post("/signals", createSignal);

// GET    /api/admin/signals       — retrieve all trade signals
adminDashboardRouter.get("/signals", getAllSignals);

// DELETE  /api/admin/signals/:id  — delete a specific signal
adminDashboardRouter.delete("/signals/:id", deleteSignal);

// PUT     /api/admin/signals/:id  — update signal details (tp, sl, entry)
adminDashboardRouter.put("/signals/:id", updateSignal);

// PATCH   /api/admin/signals/:id/result — update signal result (win/loss)
adminDashboardRouter.patch("/signals/:id/result", updateSignalResult);

export default adminDashboardRouter;
