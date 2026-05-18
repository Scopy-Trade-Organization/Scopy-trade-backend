import { Schema, model, InferSchemaType, HydratedDocument } from "mongoose";

const auditLogSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    admin: {
      type: Schema.Types.ObjectId,
      ref: "Admin",
    },
    action: {
      type: String,
      required: true,
    },
    targetId: Schema.Types.ObjectId,
    targetType: String,
    ipAddress: String,
    userAgent: String,
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
    details: {
      type: Schema.Types.Mixed,
    },
  },
  { timestamps: true },
);

export type AuditLog = InferSchemaType<typeof auditLogSchema>;
export type AuditLogDocument = HydratedDocument<AuditLog>;

const AuditLog = model("AuditLog", auditLogSchema);

export default AuditLog;
