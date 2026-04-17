import { Types } from "mongoose";

declare global {
  namespace Express {
    interface Request {
      user?: Types.ObjectId;
      admin?: Types.ObjectId;
    }
  }
}
