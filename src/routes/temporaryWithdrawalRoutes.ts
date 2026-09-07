import { Router } from "express";
import { testUserUsdtWithdrawal } from "../controllers/temporaryWithdrawalController.js";

const temporaryWithdrawalRouter = Router();

// Intentionally unauthenticated for temporary Postman testing.
temporaryWithdrawalRouter.post("/withdraw-usdt", testUserUsdtWithdrawal);

export default temporaryWithdrawalRouter;
