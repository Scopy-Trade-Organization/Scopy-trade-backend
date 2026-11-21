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
import { validateConnectBody, validateCredentialUpdateBody } from "../middleware/validateExchange.js";
import { connectionLimiter } from "../middleware/rateLimit.js";
import { getServerIps } from "../services/serverIpService.js";

const exchangeRouter = Router();

// Public setup information must be registered before authentication.
exchangeRouter.get("/server-ip", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const ips = await getServerIps();
    res.json({ success: true, ips });
  } catch {
    res.status(503).json({
      success: false,
      message: "Server IP addresses are temporarily unavailable. Please try again.",
    });
  }
});

// Every route below requires a valid JWT.
exchangeRouter.use(userAuthenticate);

// GET  /api/exchanges              — list supported exchanges + connection status
exchangeRouter.get("/", getSupportedExchanges);

// POST /api/exchanges/connect      — validate, encrypt, and store credentials
exchangeRouter.post(
  "/connect",
  connectionLimiter,
  validateConnectBody,
  connectExchange,
);

// GET  /api/exchanges/connections  — user's active connections (no secrets)
exchangeRouter.get("/connections", getUserConnections);

// DELETE /api/exchanges/connections/:connectionId — soft delete + wipe keys
exchangeRouter.delete("/connections/:connectionId", removeConnection);

exchangeRouter.patch(
  "/connections/:connectionId",
  connectionLimiter,
  validateCredentialUpdateBody,
  updateConnectionCredentials,
);

// POST /api/exchanges/connections/:connectionId/test — re-validate live
exchangeRouter.post(
  "/connections/:connectionId/test",
  connectionLimiter,
  testConnection,
);

export default exchangeRouter;
