import rateLimit from "express-rate-limit";

const rateLimitedResponse = {
  success: false,
  message: "Too many requests. Please try again later.",
};

/** Applied to signup/login/refresh/reset-password — brute-force-prone endpoints. */
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: rateLimitedResponse,
});

/** Tighter limit for forgot-password, which also triggers an outbound email. */
export const passwordResetRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: rateLimitedResponse,
});
