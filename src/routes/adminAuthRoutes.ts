import { Router } from "express";
import {
  adminLogin,
  adminLogout,
  AdminRefreshToken,
  adminWhoami,
} from "../controllers/adminAuthController.js";
import { adminAuthenticate } from "../middleware/authenticationMiddleware.js";

const adminAuthRouter = Router();

// POST /api/admin/auth/login
adminAuthRouter.post("/login", adminLogin);

// POST /api/admin/auth/logout
adminAuthRouter.post("/logout", adminLogout);

// POST /api/admin/auth/refresh
adminAuthRouter.post("/refresh", AdminRefreshToken);

// Admin Info route
adminAuthRouter.get("/me", adminAuthenticate, adminWhoami);

export default adminAuthRouter;
