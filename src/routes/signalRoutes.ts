import { Router } from "express";
import { getAllSignals } from "../controllers/signalController.js";

const signalRouter = Router();

// GET /api/signals
signalRouter.get("/", getAllSignals);

export default signalRouter;
