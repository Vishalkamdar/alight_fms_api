import { NextFunction, Request, Response } from "express";
import { ZodType } from "zod";
import { AppError } from "../utils/AppError";

type Source = "body" | "query" | "params";

/**
 * Validates req[source] against `schema` and stores the parsed/coerced
 * result on res.locals[source]. Controllers read from res.locals rather
 * than req.query/req.body directly, since req.query is not safely
 * reassignable across Express versions.
 */
export function validate(schema: ZodType, source: Source = "body") {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
      const errors: Record<string, string[]> = {};
      for (const issue of result.error.issues) {
        const key = issue.path.join(".") || source;
        const existing = errors[key] ?? [];
        errors[key] = existing.includes(issue.message) ? existing : [...existing, issue.message];
      }
      throw new AppError(422, "Validation failed.", errors);
    }

    res.locals[source] = result.data;
    next();
  };
}
