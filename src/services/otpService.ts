import crypto from "crypto";
import EmailOtp, { EmailOtpPurpose } from "../models/emailOtpModel.js";

const MAX_ATTEMPTS = 5;

function secret(): string {
  const value = process.env.OTP_SECRET?.trim();
  if (!value) throw new Error("Missing required OTP configuration: OTP_SECRET");
  if (Buffer.byteLength(value, "utf8") < 32) throw new Error("OTP_SECRET must be at least 32 bytes long");
  return value;
}

function hash(value: string): string {
  return crypto.createHmac("sha256", secret()).update(value).digest("hex");
}

export function hashOtpContext(value: string): string {
  return hash(`context:${value}`);
}

export async function issueOtp(input: {
  email: string;
  purpose: EmailOtpPurpose;
  userId?: unknown;
  context?: string;
}): Promise<string> {
  const email = input.email.trim().toLowerCase();
  const code = crypto.randomInt(100000, 1000000).toString();
  const configuredMinutes = Number(process.env.OTP_EXPIRY_MINUTES || 10);
  const expiresInMinutes = Number.isFinite(configuredMinutes) ? Math.max(1, configuredMinutes) : 10;
  await EmailOtp.deleteMany({ email, purpose: input.purpose, usedAt: null });
  await EmailOtp.create({
    email,
    userId: input.userId ?? null,
    purpose: input.purpose,
    codeHash: hash(`${email}:${input.purpose}:${code}`),
    contextHash: input.context ? hashOtpContext(input.context) : null,
    expiresAt: new Date(Date.now() + expiresInMinutes * 60_000),
  });
  return code;
}

export async function consumeOtp(input: {
  email: string;
  purpose: EmailOtpPurpose;
  code: unknown;
  context?: string;
}): Promise<boolean> {
  const email = input.email.trim().toLowerCase();
  if (!/^\d{6}$/.test(String(input.code ?? ""))) return false;
  const otp = await EmailOtp.findOne({
    email,
    purpose: input.purpose,
    usedAt: null,
    expiresAt: { $gt: new Date() },
    attempts: { $lt: MAX_ATTEMPTS },
  }).sort({ createdAt: -1 }).select("+codeHash +contextHash");
  if (!otp) return false;

  const suppliedHash = hash(`${email}:${input.purpose}:${String(input.code)}`);
  const codeMatches = crypto.timingSafeEqual(Buffer.from(suppliedHash), Buffer.from(otp.codeHash));
  const contextMatches = input.context === undefined
    ? !otp.contextHash
    : otp.contextHash === hashOtpContext(input.context);
  if (!codeMatches || !contextMatches) {
    await EmailOtp.updateOne({ _id: otp._id, usedAt: null }, { $inc: { attempts: 1 } });
    return false;
  }
  const consumed = await EmailOtp.updateOne(
    { _id: otp._id, usedAt: null },
    { $set: { usedAt: new Date() } },
  );
  return consumed.modifiedCount === 1;
}
