import jwt, { SignOptions } from "jsonwebtoken";

export const signAccessToken = (id: string): string => {
  const secret = process.env.JWT_SECRET;
  const expiresIn = process.env.JWT_EXPIRES_IN;

  if (!secret) throw new Error("JWT_SECRET is not defined");
  if (!expiresIn) throw new Error("JWT_EXPIRES_IN is not defined");

  return jwt.sign({ id }, secret, {
    expiresIn: expiresIn as NonNullable<SignOptions["expiresIn"]>,
  });
};

export const signRefreshToken = (id: string): string => {
  const secret = process.env.JWT_SECRET;
  const expiresIn = process.env.JWT_REFRESH_EXPIRES_IN;

  if (!secret) throw new Error("JWT_REFRESH_SECRET is not defined");
  if (!expiresIn) throw new Error("JWT_REFRESH_EXPIRES_IN is not defined");

  return jwt.sign({ id, type: "refresh" }, secret, {
    expiresIn: expiresIn as NonNullable<SignOptions["expiresIn"]>,
  });
};
