import { Router } from "express";
import { adminLogin, adminLogout } from "../controllers/adminAuthController.js";

const adminAuthRouter = Router();

// POST /api/admin/auth/login
adminAuthRouter.post("/login", adminLogin);

// POST /api/admin/auth/logout
adminAuthRouter.post("/logout", adminLogout);

export default adminAuthRouter;
