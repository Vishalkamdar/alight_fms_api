import { Types } from "mongoose";
import { AppError } from "../../utils/AppError";
import { recordAudit } from "../../utils/fms/audit-log";
import { hashPassword } from "../../utils/password";
import { revokeAllRefreshTokensForUser } from "../../utils/refreshToken";
import { sendWelcomeEmail } from "../email.service";
import { UserModel, UserDocument, type UserRole } from "../../models/User";
import type { CreateUserInput, UpdateUserInput, UserListQuery } from "../../schemas/fms/user.schema";

function toSafeUser(user: UserDocument) {
  return {
    _id: String(user._id),
    fullname: user.fullname,
    email: user.email,
    countryCode: user.countryCode,
    phone: user.phone,
    role: user.role,
    isActive: user.isActive,
    isEmailVerified: user.isEmailVerified,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

/** Only a Super Admin may create or promote another Super Admin. */
function resolveCreatableRole(requestedRole: UserRole | undefined, actorRole: UserRole): UserRole {
  if (requestedRole === "Super Admin" && actorRole !== "Super Admin") {
    throw new AppError(403, "Only a Super Admin can create another Super Admin account.");
  }
  return requestedRole ?? "Admin";
}

export interface RequestContext {
  actorId: Types.ObjectId;
  actorRole: UserRole;
  ipAddress: string | null;
}

export async function createUser(input: CreateUserInput, context: RequestContext) {
  const email = input.email.toLowerCase().trim();

  const [emailTaken, phoneTaken] = await Promise.all([
    UserModel.exists({ email }),
    UserModel.exists({ phone: input.phone }),
  ]);

  if (emailTaken) {
    throw new AppError(409, "A user with this email already exists.", {
      email: ["Email already in use."],
    });
  }
  if (phoneTaken) {
    throw new AppError(409, "A user with this phone number already exists.", {
      phone: ["Phone number already in use."],
    });
  }

  const role = resolveCreatableRole(input.role, context.actorRole);
  const password = await hashPassword(input.password);

  const user = await UserModel.create({
    fullname: input.fullname,
    email,
    password,
    countryCode: input.countryCode,
    phone: input.phone,
    role,
  });

  await recordAudit({
    user: context.actorId,
    action: "User Created",
    entity: "User",
    entityId: user._id,
    newValue: toSafeUser(user),
    ipAddress: context.ipAddress,
  });

  void sendWelcomeEmail(user.email, user.fullname).catch((error: unknown) =>
    console.error("[email] failed to send welcome email:", error)
  );

  return toSafeUser(user);
}

export interface ListResult<T> {
  items: T[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

export async function listUsers(query: UserListQuery): Promise<ListResult<ReturnType<typeof toSafeUser>>> {
  const filter: Record<string, unknown> = {};
  if (query.role) filter.role = query.role;
  if (query.isActive !== undefined) filter.isActive = query.isActive;
  if (query.search) {
    filter.$or = [
      { fullname: { $regex: query.search, $options: "i" } },
      { email: { $regex: query.search, $options: "i" } },
    ];
  }

  const [users, total] = await Promise.all([
    UserModel.find(filter)
      .sort({ [query.sortBy]: query.sortOrder === "asc" ? 1 : -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    UserModel.countDocuments(filter),
  ]);

  return {
    items: users.map(toSafeUser),
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(Math.ceil(total / query.limit), 1),
    },
  };
}

export async function getUserById(id: string) {
  const user = await UserModel.findById(id);
  if (!user) throw new AppError(404, "User not found.");
  return toSafeUser(user);
}

export async function updateUser(id: string, input: UpdateUserInput, context: RequestContext) {
  const user = await UserModel.findById(id);
  if (!user) throw new AppError(404, "User not found.");

  if (input.role === "Super Admin" && context.actorRole !== "Super Admin" && user.role !== "Super Admin") {
    throw new AppError(403, "Only a Super Admin can promote a user to Super Admin.");
  }
  if (user.role === "Super Admin" && input.role && input.role !== "Super Admin" && context.actorRole !== "Super Admin") {
    throw new AppError(403, "Only a Super Admin can change another Super Admin's role.");
  }

  const previousValue = toSafeUser(user);

  if (input.fullname !== undefined) user.fullname = input.fullname;
  if (input.countryCode !== undefined) user.countryCode = input.countryCode;
  if (input.phone !== undefined) user.phone = input.phone;
  if (input.role !== undefined) user.role = input.role;

  await user.save();

  await recordAudit({
    user: context.actorId,
    action: "User Updated",
    entity: "User",
    entityId: user._id,
    previousValue,
    newValue: toSafeUser(user),
    ipAddress: context.ipAddress,
  });

  return toSafeUser(user);
}

export async function updateUserStatus(id: string, isActive: boolean, context: RequestContext) {
  const user = await UserModel.findById(id);
  if (!user) throw new AppError(404, "User not found.");

  if (user.role === "Super Admin" && !isActive && context.actorRole !== "Super Admin") {
    throw new AppError(403, "Only a Super Admin can deactivate another Super Admin.");
  }

  if (user.isActive === isActive) {
    return toSafeUser(user);
  }

  const previousValue = toSafeUser(user);
  user.isActive = isActive;

  if (!isActive) {
    // Deactivating a user must end every live session immediately.
    user.tokenVersion += 1;
    await revokeAllRefreshTokensForUser(user._id);
  }

  await user.save();

  await recordAudit({
    user: context.actorId,
    action: isActive ? "User Activated" : "User Deactivated",
    entity: "User",
    entityId: user._id,
    previousValue,
    newValue: toSafeUser(user),
    ipAddress: context.ipAddress,
  });

  return toSafeUser(user);
}
