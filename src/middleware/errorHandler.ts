import { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import { AppError } from "../utils/AppError";

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ success: false, message: err.message, errors: err.errors });
    return;
  }

  if (err instanceof mongoose.Error.CastError) {
    res.status(400).json({ success: false, message: `Invalid id: ${String(err.value)}` });
    return;
  }

  if (err instanceof mongoose.Error.ValidationError) {
    const errors: Record<string, string[]> = {};
    for (const [field, validatorError] of Object.entries(err.errors)) {
      errors[field] = [validatorError.message];
    }
    res.status(400).json({ success: false, message: "Validation failed.", errors });
    return;
  }

  if (typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === 11000) {
    const keyValue = (err as { keyValue?: Record<string, unknown> }).keyValue ?? {};
    const field = Object.keys(keyValue)[0] ?? "field";
    res.status(409).json({
      success: false,
      message: `${field} "${String(keyValue[field])}" already exists.`,
      errors: { [field]: [`${field} must be unique.`] },
    });
    return;
  }

  console.error(err);
  res.status(500).json({ success: false, message: "Internal server error." });
}
