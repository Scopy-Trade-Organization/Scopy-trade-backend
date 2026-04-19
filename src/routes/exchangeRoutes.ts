import { Router } from "express";
import {
  getSupportedExchanges,
  connectExchange,
  getUserConnections,
  removeConnection,
  testConnection,
} from "../controllers/exchangeController";
import { authenticate } from "../middleware/auth";
import { validateConnectBody } from "../middleware/validateExchange";

const router = Router();

// All routes require a valid JWT
router.use(authenticate);

// GET  /api/exchanges              — list supported exchanges + connection status
router.get("/", getSupportedExchanges);

// POST /api/exchanges/connect      — validate, encrypt, and store credentials
router.post("/connect", validateConnectBody, connectExchange);

// GET  /api/exchanges/connections  — user's active connections (no secrets)
router.get("/connections", getUserConnections);

// DELETE /api/exchanges/connections/:connectionId — soft delete + wipe keys
router.delete("/connections/:connectionId", removeConnection);

// POST /api/exchanges/connections/:connectionId/test — re-validate live
router.post("/connections/:connectionId/test", testConnection);

export default router;
