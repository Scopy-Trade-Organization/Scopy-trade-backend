import { Router } from "express";
import {
  getSupportedExchanges,
  connectExchange,
  getUserConnections,
  removeConnection,
  testConnection,
  updateConnectionCredentials,
} from "../controllers/exchangeController.js";
import { userAuthenticate } from "../middleware/authenticationMiddleware.js";
import { validateConnectBody } from "../middleware/validateExchange.js";
import { testConnectionLimiter } from "../middleware/rateLimit.js";

const router = Router();

// All routes require a valid JWT
router.use(userAuthenticate);

// GET  /api/exchanges              — list supported exchanges + connection status
router.get("/", getSupportedExchanges);

// POST /api/exchanges/connect      — validate, encrypt, and store credentials
router.post("/connect", validateConnectBody, connectExchange);

// GET  /api/exchanges/connections  — user's active connections (no secrets)
router.get("/connections", getUserConnections);

// DELETE /api/exchanges/connections/:connectionId — soft delete + wipe keys
router.delete("/connections/:connectionId", removeConnection);

router.patch("/connections/:connectionId", updateConnectionCredentials);

// POST /api/exchanges/connections/:connectionId/test — re-validate live
router.post(
  "/connections/:connectionId/test",
  testConnectionLimiter,
  testConnection,
);

export default router;
