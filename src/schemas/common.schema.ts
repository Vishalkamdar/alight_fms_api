import { z } from "zod";

export const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, "Invalid id.");

export const objectIdParamsSchema = z.object({
  id: objectIdSchema,
});
