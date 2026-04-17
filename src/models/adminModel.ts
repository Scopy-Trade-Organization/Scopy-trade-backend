import validator from "validator";
import { Schema, model, InferSchemaType, HydratedDocument } from "mongoose";

const adminSchema = new Schema(
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
    oauthProviders: {
      google: { type: String },
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      validate: {
        validator: function (value: string) {
          return validator.isEmail(value);
        },
        message: "Invalid email format",
      },
    },
    phone: {
      type: String,
      sparse: true,
      trim: true,
      validate: {
        validator: function (value: string) {
          // Allow empty phone numbers (since sparse: true)
          if (!value) return true;
          return validator.isMobilePhone(value, "any");
        },
        message: "Invalid phone number format",
      },
    },
    password: {
      type: String,
      minlength: 8,
    },
    profilePhoto: {
      publicId: { type: String },
      url: { type: String },
    },
  },
  { timestamps: true },
);

export type Admin = InferSchemaType<typeof adminSchema>;
export type AdminDocument = HydratedDocument<Admin>;
const Admin = model("Admin", adminSchema);

export default Admin;
