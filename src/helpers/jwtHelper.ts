import jwt, { JwtPayload, SignOptions } from "jsonwebtoken";

export type PrincipalType = "user" | "admin";
export type TokenType = "user_access" | "admin_access" | "user_refresh" | "admin_refresh";

export interface SessionJwtPayload extends JwtPayload {
  sub: string;
  tokenType: TokenType;
  sv: number;
}

const issuer = "scopy-trade";
const accessSecret = () => process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET;
const refreshSecret = () => process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET;

function signToken(id: string, sessionVersion: number, tokenType: TokenType, expiresIn: string | undefined, secret: string | undefined): string {
  if (!secret) throw new Error("JWT signing secret is not configured");
  if (!expiresIn) throw new Error("JWT expiration is not configured");
  return jwt.sign({ tokenType, sv: sessionVersion }, secret, {
    subject: id,
    issuer,
    audience: tokenType.startsWith("admin_") ? "admin" : "user",
    algorithm: "HS256",
    expiresIn: expiresIn as NonNullable<SignOptions["expiresIn"]>,
  });
}

export const signAccessToken = (id: string, principal: PrincipalType, sessionVersion: number): string => {
  return signToken(id, sessionVersion, `${principal}_access`, process.env.JWT_EXPIRES_IN, accessSecret());
};

export const signRefreshToken = (id: string, principal: PrincipalType, sessionVersion: number): string => {
  return signToken(id, sessionVersion, `${principal}_refresh`, process.env.JWT_REFRESH_EXPIRES_IN, refreshSecret());
};

export function verifyToken(token: string, principal: PrincipalType, refresh = false): SessionJwtPayload {
  const secret = refresh ? refreshSecret() : accessSecret();
  if (!secret) throw new Error("JWT verification secret is not configured");
  const expectedType: TokenType = `${principal}_${refresh ? "refresh" : "access"}`;
  const decoded = jwt.verify(token, secret, {
    algorithms: ["HS256"],
    issuer,
    audience: principal,
  }) as SessionJwtPayload;
  if (!decoded.sub || decoded.tokenType !== expectedType || !Number.isInteger(decoded.sv)) {
    throw new Error("Invalid session token");
  }
  return decoded;
}
