import { z } from "zod";
import { USER_ROLES } from "../../models/User";
import { PASSWORD_POLICY_MESSAGE, PASSWORD_POLICY_REGEX } from "../../utils/password";

const passwordSchema = z.string().min(8, PASSWORD_POLICY_MESSAGE).regex(PASSWORD_POLICY_REGEX, {
  message: PASSWORD_POLICY_MESSAGE,
});

export const createUserSchema = z.object({
  fullname: z.string().trim().min(2, "Full name must be at least 2 characters.").max(150),
  email: z.string().trim().toLowerCase().min(1, "Email is required.").email("Enter a valid email address."),
  password: passwordSchema,
  countryCode: z.string().trim().min(1, "Country code is required.").max(6),
  phone: z
    .string()
    .trim()
    .min(6, "Enter a valid phone number.")
    .max(15, "Enter a valid phone number.")
    .regex(/^\d+$/, "Phone number must contain digits only."),
  role: z.enum(USER_ROLES).optional(),
});

export const updateUserSchema = z.object({
  fullname: z.string().trim().min(2).max(150).optional(),
  countryCode: z.string().trim().min(1).max(6).optional(),
  phone: z
    .string()
    .trim()
    .min(6, "Enter a valid phone number.")
    .max(15, "Enter a valid phone number.")
    .regex(/^\d+$/, "Phone number must contain digits only.")
    .optional(),
  role: z.enum(USER_ROLES).optional(),
});

export const updateUserStatusSchema = z.object({
  isActive: z.boolean(),
});

export const userListQuerySchema = z.object({
  search: z.string().trim().optional(),
  role: z.enum(USER_ROLES).optional(),
  isActive: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(20),
  sortBy: z.string().default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type UserListQuery = z.infer<typeof userListQuerySchema>;
