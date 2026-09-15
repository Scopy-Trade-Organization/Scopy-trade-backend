import { Router } from "express";
import { simulateProfitShareWithdrawal, simulateSuccessfulTradeClose } from "../controllers/temporaryWithdrawalController.js";
import { requireRole, userAuthenticate } from "../middleware/authenticationMiddleware.js";

const temporaryWithdrawalRouter = Router();

temporaryWithdrawalRouter.use((_req, res, next) => {
  if (process.env.ENABLE_TEMPORARY_TEST_ENDPOINTS !== "true") {
    return res.status(404).json({ success: false, message: "Not found." });
  }
  return next();
});
temporaryWithdrawalRouter.use(userAuthenticate);
temporaryWithdrawalRouter.post("/trade-close", requireRole(["Pro Trader"]), simulateSuccessfulTradeClose);
temporaryWithdrawalRouter.post("/withdraw-usdt", requireRole(["CopyTrader"]), simulateProfitShareWithdrawal);

export default temporaryWithdrawalRouter;
