import { Router } from "express";
import {
  activateUser,
  fetchAllUsers,
  getAllSignals,
  suspendUser,
} from "../controllers/adminDashboardController.js";
import { adminAuthenticate } from "../middleware/authenticationMiddleware.js";

const adminDashboardRouter = Router();

// All routes require admin authentication
adminDashboardRouter.use(adminAuthenticate);

adminDashboardRouter.get("/signals", getAllSignals);
adminDashboardRouter.get("/users", fetchAllUsers);
adminDashboardRouter.put("/users/:id/suspend", suspendUser);
adminDashboardRouter.put("/users/:id/activate", activateUser);

export default adminDashboardRouter;
