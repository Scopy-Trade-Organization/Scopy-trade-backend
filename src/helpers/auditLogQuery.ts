import { Types } from "mongoose";

export function auditLogQuery(query: Record<string, unknown>) {
  const read = (key: string) => {
    const value = query[key];
    if (value === undefined) return "";
    if (typeof value !== "string") throw new Error(`Invalid ${key}.`);
    return value.trim();
  };
  const page = Number(read("page") || 1);
  const limit = Number(read("limit") || 20);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger((page - 1) * limit)) throw new Error("Invalid page.");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Limit must be between 1 and 100.");
  const filter: Record<string, unknown> = {};
  const action = read("action");
  if (action.length > 200) throw new Error("Action is too long.");
  if (action) filter.action = action;
  const date = (key: string) => {
    const value = read(key);
    if (!value) return undefined;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error(`Invalid ${key}.`);
    return parsed;
  };
  const from = date("dateFrom");
  const to = date("dateTo");
  if (from && to && from > to) throw new Error("From date must be before or equal to to date.");
  if (from || to) filter.timestamp = { ...(from ? { $gte: from } : {}), ...(to ? { $lt: new Date(to.getTime() + 86400000) } : {}) };
  const search = read("search");
  if (search.length > 200) throw new Error("Search must be 200 characters or fewer.");
  if (search) {
    const pattern = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const alternatives: Record<string, unknown>[] = [{ action: pattern }, { ipAddress: pattern }, { userAgent: pattern }];
    if (/^[a-f\d]{24}$/i.test(search)) {
      const id = new Types.ObjectId(search);
      for (const field of ["_id", "userId", "admin", "targetId"]) alternatives.push({ [field]: id });
    }
    filter.$or = alternatives;
  }
  return { filter, page, limit };
}
