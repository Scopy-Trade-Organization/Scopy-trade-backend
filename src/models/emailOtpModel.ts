import { Schema, model, InferSchemaType } from "mongoose";

const emailOtpSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    purpose: {
      type: String,
      enum: ["signup", "password-reset", "withdrawal"],
      required: true,
      index: true,
    },
    codeHash: { type: String, required: true, select: false },
    contextHash: { type: String, default: null, select: false },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

emailOtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
emailOtpSchema.index({ email: 1, purpose: 1, createdAt: -1 });

export type EmailOtpPurpose = "signup" | "password-reset" | "withdrawal";
export type EmailOtp = InferSchemaType<typeof emailOtpSchema>;

export default model("EmailOtp", emailOtpSchema);
