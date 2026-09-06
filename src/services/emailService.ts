import axios from "axios";
import User from "../models/userModel.js";

interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface TradeEmailDetails {
  pair: string;
  direction: string;
  quantity: string;
  entryPrice: string;
  exitPrice?: string | null;
  realizedPnl?: string | null;
  tradeResult?: string | null;
}

let accessTokenCache: { token: string; expiresAt: number } | null = null;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required email configuration: ${name}`);
  return value;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function base64Url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function mimeWord(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

async function getAccessToken(): Promise<string> {
  if (accessTokenCache && accessTokenCache.expiresAt > Date.now() + 60_000) {
    return accessTokenCache.token;
  }
  const { data } = await axios.post<{ access_token: string; expires_in?: number }>(
    "https://oauth2.googleapis.com/token",
    new URLSearchParams({
      client_id: requiredEnv("GMAIL_CLIENT_ID"),
      client_secret: requiredEnv("GMAIL_CLIENT_SECRET"),
      refresh_token: requiredEnv("GMAIL_REFRESH_TOKEN"),
      grant_type: "refresh_token",
    }).toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
  );
  accessTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  return data.access_token;
}

function renderLayout(title: string, intro: string, content: string): string {
  return `<!doctype html><html><body style="margin:0;background:#0b1020;color:#eef2ff;font-family:Arial,sans-serif"><div style="max-width:600px;margin:0 auto;padding:32px 18px"><div style="background:#151b2f;border:1px solid #29304a;border-radius:18px;padding:32px"><div style="color:#74e0b1;font-weight:800;letter-spacing:.08em;margin-bottom:24px">SCOPYTRADE</div><h1 style="font-size:26px;margin:0 0 12px">${escapeHtml(title)}</h1><p style="color:#b8bfd3;line-height:1.6;margin:0 0 22px">${escapeHtml(intro)}</p>${content}<p style="color:#737b91;font-size:12px;line-height:1.5;margin:28px 0 0">If you did not initiate this action, please secure your account and contact support.</p></div></div></body></html>`;
}

export async function sendEmail(message: EmailMessage): Promise<void> {
  const senderEmail = requiredEnv("GMAIL_SENDER_EMAIL");
  const senderName = process.env.GMAIL_SENDER_NAME?.trim() || "SCopyTrade";
  const boundary = `scopy_${Date.now().toString(36)}`;
  const raw = [
    `From: ${mimeWord(senderName)} <${senderEmail}>`,
    `To: ${message.to}`,
    `Subject: ${mimeWord(message.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(message.text, "utf8").toString("base64"),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(message.html, "utf8").toString("base64"),
    `--${boundary}--`,
  ].join("\r\n");

  await axios.post(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    { raw: base64Url(raw) },
    { headers: { Authorization: `Bearer ${await getAccessToken()}` } },
  );
}

export async function sendOtpEmail(
  to: string,
  firstName: string,
  code: string,
  purpose: "signup" | "password-reset" | "withdrawal",
): Promise<void> {
  const labels = {
    signup: "Verify your email",
    "password-reset": "Reset your password",
    withdrawal: "Confirm your withdrawal",
  } as const;
  const configuredMinutes = Number(process.env.OTP_EXPIRY_MINUTES || 10);
  const minutes = Number.isFinite(configuredMinutes) ? Math.max(1, configuredMinutes) : 10;
  const title = labels[purpose];
  const intro = `Hi ${firstName || "there"}, use the verification code below to continue. It expires in ${minutes} minutes.`;
  const codeHtml = `<div style="font-size:32px;font-weight:800;letter-spacing:10px;text-align:center;background:#0b1020;border-radius:12px;padding:18px;color:#74e0b1">${escapeHtml(code)}</div>`;
  await sendEmail({
    to,
    subject: `${code} is your SCopyTrade verification code`,
    text: `${intro}\n\nVerification code: ${code}\n\nDo not share this code with anyone.`,
    html: renderLayout(title, intro, codeHtml),
  });
}

export async function sendWelcomeEmail(
  to: string,
  firstName: string,
  status: "active" | "waitlist",
): Promise<void> {
  const waitlisted = status === "waitlist";
  const intro = waitlisted
    ? `Hi ${firstName}, your email is verified and your SCopyTrade account has been added to the waitlist. We'll email you when access is activated.`
    : `Hi ${firstName}, your email is verified and your SCopyTrade account is active. You can now sign in and get started.`;
  await sendEmail({
    to,
    subject: waitlisted ? "Welcome to the SCopyTrade waitlist" : "Welcome to SCopyTrade",
    text: intro,
    html: renderLayout("Welcome to SCopyTrade", intro, ""),
  });
}

export function queueEmail(label: string, task: () => Promise<void>): void {
  setImmediate(() => void task().catch((error) => console.error(`[emailService] ${label}:`, error)));
}

export function queueTradeEmail(
  userId: unknown,
  event: "opened" | "copied" | "closed",
  details: TradeEmailDetails,
): void {
  queueEmail(`trade ${event} notification failed`, async () => {
    const user = await User.findById(userId).select("email firstName").lean();
    if (!user) return;
    const eventLabel = event === "copied" ? "copied successfully" : `${event} successfully`;
    const rows = [
      ["Pair", details.pair], ["Direction", details.direction.toUpperCase()],
      ["Quantity", details.quantity], ["Entry price", details.entryPrice],
      ...(event === "closed" ? [["Exit price", details.exitPrice || "Unavailable"], ["Result", details.tradeResult || "Unavailable"], ["Realized PnL", details.realizedPnl || "0"]] : []),
    ];
    const content = `<div style="background:#0b1020;border-radius:12px;padding:18px">${rows.map(([key, value]) => `<p style="margin:8px 0;color:#b8bfd3"><strong style="color:#eef2ff">${escapeHtml(key)}:</strong> ${escapeHtml(value)}</p>`).join("")}</div>`;
    const intro = `Hi ${user.firstName}, your ${details.pair} trade was ${eventLabel}.`;
    await sendEmail({ to: user.email, subject: `Trade ${eventLabel}: ${details.pair}`, text: `${intro}\n${rows.map(([key, value]) => `${key}: ${value}`).join("\n")}`, html: renderLayout(`Trade ${eventLabel}`, intro, content) });
  });
}

export function queueWithdrawalSuccessEmail(userId: unknown, amount: number, address: string, transactionId: string): void {
  queueEmail("withdrawal notification failed", async () => {
    const user = await User.findById(userId).select("email firstName").lean();
    if (!user) return;
    const intro = `Hi ${user.firstName}, your withdrawal of ${amount} USDT was submitted successfully.`;
    const content = `<p style="color:#b8bfd3">Destination: ${escapeHtml(address)}<br>Transaction ID: ${escapeHtml(transactionId)}</p>`;
    await sendEmail({ to: user.email, subject: "Your SCopyTrade withdrawal was successful", text: `${intro}\nDestination: ${address}\nTransaction ID: ${transactionId}`, html: renderLayout("Withdrawal successful", intro, content) });
  });
}

export function queueAccountStatusEmail(to: string, firstName: string, status: "active" | "suspended", reason?: string): void {
  queueEmail(`account ${status} notification failed`, async () => {
    const intro = status === "active"
      ? `Hi ${firstName}, your SCopyTrade account has been activated. You can now sign in and use the platform.`
      : `Hi ${firstName}, your SCopyTrade account has been suspended.${reason ? ` Reason: ${reason}` : " Please contact support if you need assistance."}`;
    await sendEmail({ to, subject: `Your SCopyTrade account was ${status}`, text: intro, html: renderLayout(`Account ${status}`, intro, "") });
  });
}
