import { Router } from "express";
import { getAllSignals } from "../controllers/signalController.js";

const signalRouter = Router();

signalRouter.get("/", getAllSignals);

export default signalRouter;
