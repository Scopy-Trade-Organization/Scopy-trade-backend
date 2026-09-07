import { Request, Response } from "express";
import mongoose from "mongoose";
import { ExchangeConnection } from "../models/exchangeConnectionModel.js";
import { decryptCredentials } from "../services/exchangeConnectionService.js";
import { getPlatformWallet, withdrawUsdt } from "../services/withdrawalService.js";
import { ExchangeId } from "../types/index.js";

const USDT_AMOUNT_PATTERN = /^\d+(\.\d{1,6})?$/;

/**
 * TEMPORARY, UNAUTHENTICATED test endpoint. Remove this controller and its
 * route as soon as post-trade withdrawal testing is complete.
 */
export async function testUserUsdtWithdrawal(req: Request, res: Response) {
  try {
    const { exchangeConnectionId, amount, requestId } = req.body;
    const amountText = String(amount ?? "").trim();
    const numericAmount = Number(amountText);

    if (!mongoose.isValidObjectId(exchangeConnectionId)) {
      return res.status(400).json({
        success: false,
        message: "A valid exchangeConnectionId is required.",
      });
    }

    if (
      !USDT_AMOUNT_PATTERN.test(amountText) ||
      !Number.isFinite(numericAmount) ||
      numericAmount <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Amount must be positive USDT with at most 6 decimal places.",
      });
    }

    if (typeof requestId !== "string" || !/^[A-Za-z0-9]{1,32}$/.test(requestId)) {
      return res.status(400).json({
        success: false,
        message: "requestId must contain 1-32 letters or numbers.",
      });
    }

    const connection = await ExchangeConnection.findOne({
      _id: exchangeConnectionId,
      isActive: true,
    }).lean();
    if (!connection) {
      return res.status(404).json({
        success: false,
        message: "Active exchange connection not found.",
      });
    }

    if (!connection.encryptedApiKey || !connection.encryptedApiSecret) {
      return res.status(422).json({
        success: false,
        message: "The exchange connection does not contain usable credentials.",
      });
    }

    const credentials = decryptCredentials({
      exchange: connection.exchange as ExchangeId,
      apiKey: connection.encryptedApiKey,
      apiSecret: connection.encryptedApiSecret,
      ...(connection.encryptedPassphrase
        ? { passphrase: connection.encryptedPassphrase }
        : {}),
    });
    const wallet = getPlatformWallet();
    const withdrawal = await withdrawUsdt(
      connection.exchange as ExchangeId,
      credentials,
      amountText,
      wallet.address,
      wallet.network,
      requestId,
    );
    const mode = process.env.PROFIT_WITHDRAWAL_MODE === "live" ? "live" : "dry-run";

    return res.status(200).json({
      success: true,
      message:
        mode === "live"
          ? "USDT withdrawal confirmed successful by the exchange."
          : "USDT withdrawal dry run completed; no funds were moved.",
      withdrawal: {
        mode,
        requestId,
        transactionId: withdrawal.transactionId,
        status: withdrawal.status,
        blockchainTransactionId: withdrawal.blockchainTransactionId || null,
        exchange: connection.exchange,
        amount: amountText,
        network: wallet.network,
        destinationAddress: wallet.address,
      },
    });
  } catch (error) {
    console.error("[temporary user USDT withdrawal]", error);
    return res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : "Withdrawal failed.",
    });
  }
}
