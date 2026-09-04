import { Schema, model, InferSchemaType, HydratedDocument } from "mongoose";
import validator from "validator";
import bcrypt from "bcrypt";

const userSchema = new Schema(
  {
    firstName: {
      type: String,
      required: true,
      trim: true,
    },
    lastName: {
      type: String,
      required: true,
      trim: true,
    },
    googleId: {
      type: String,
      sparse: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    oauthProviders: {
      google: String,
    },
    role: {
      type: String,
      enum: ["CopyTrader", "Pro Trader"],
      default: "CopyTrader",
    },
    sponsored: {
      type: Boolean,
      default: false,
    },
    traderID: {
      type: String,
      unique: true,
      required: true,
    },
    phone: {
      type: String,
      sparse: true,
      trim: true,
      validator: function (value: string) {
        // Allow empty phone numbers (since sparse: true)
        if (!value) return true;
        return validator.isMobilePhone(value, "any");
      },
    },
    password: {
      type: String,
      minlength: 8,
      select: false,
    },
    sessionVersion: { type: Number, default: 0, select: false },
    profilePhoto: {
      publicId: { type: String },
      url: { type: String },
    },
    status: {
      type: String,
      enum: ["active", "suspended", "waitlist"],
      default: "waitlist",
    },
    isVerified: {
      type: Boolean,
      default: false,
    },
    suspendReason: {
      type: String,
    },
    address: {
      type: String,
    },
    gender: {
      type: String,
      enum: ["male", "female"],
    },
    withdrawalAddress: {
      type: String,
      trim: true,
    },
    proEarningsBalance: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { timestamps: true },
);

userSchema.methods.comparePassword = async function (enteredPassword: string) {
  return await bcrypt.compare(enteredPassword, this.password);
};

userSchema.index({ status: 1, createdAt: -1 });
userSchema.index({ isVerified: 1, createdAt: -1 });

export type IUser = InferSchemaType<typeof userSchema>;
export type UserDocument = HydratedDocument<IUser>;

const User = model("User", userSchema);

export default User;
