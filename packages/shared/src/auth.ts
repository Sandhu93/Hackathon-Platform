import { z } from 'zod';
import { normalizeEmail } from './email';

export const ROLES = ['participant', 'admin'] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

export const USER_STATUSES = ['active', 'suspended', 'revoked'] as const;
export const userStatusSchema = z.enum(USER_STATUSES);
export type UserStatus = z.infer<typeof userStatusSchema>;

export const MAILBOX_KINDS = ['personal', 'shared'] as const;
export const mailboxKindSchema = z.enum(MAILBOX_KINDS);
export type MailboxKind = z.infer<typeof mailboxKindSchema>;

/** A syntactically valid address, normalised (see email.ts). Never reveals whether it is eligible. */
export const emailSchema = z
  .string()
  .max(320)
  .transform((value, ctx) => {
    const normalized = normalizeEmail(value);
    if (!normalized) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid email address.' });
      return z.NEVER;
    }
    return normalized.email;
  });

export const OTP_LENGTH = 6;
export const otpCodeSchema = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code.');

const timestampSchema = z.string();

/** The only user fields a signed-in user sees about themselves. */
export const sessionUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string().nullable(),
  role: roleSchema,
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

export const sessionResponseSchema = z.object({
  user: sessionUserSchema,
  session: z.object({ expiresAt: timestampSchema }),
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

// ---- POST /api/auth/otp/request ------------------------------------------------------------
export const otpRequestSchema = z.object({ email: emailSchema }).strict();
/** Identical for every address, eligible or not, so the endpoint cannot be used to probe accounts. */
export const otpRequestResponseSchema = z.object({
  status: z.literal('accepted'),
  resendAfterSeconds: z.number().int(),
});
export type OtpRequestResponse = z.infer<typeof otpRequestResponseSchema>;

// ---- POST /api/auth/otp/verify -------------------------------------------------------------
export const otpVerifySchema = z.object({ email: emailSchema, code: otpCodeSchema }).strict();

// ---- Admin ---------------------------------------------------------------------------------
const displayNameSchema = z.string().trim().min(1).max(100);

export const adminUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string().nullable(),
  role: roleSchema,
  status: userStatusSchema,
  mailboxKind: mailboxKindSchema,
  /** Optimistic-concurrency token: send it back as `expectedVersion` when changing the user. */
  version: z.number().int(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  lastLoginAt: timestampSchema.nullable(),
});
export type AdminUser = z.infer<typeof adminUserSchema>;

export const adminUserListSchema = z.object({
  users: z.array(adminUserSchema),
  nextCursor: z.string().nullable(),
});
export type AdminUserList = z.infer<typeof adminUserListSchema>;

export const createUserSchema = z
  .object({
    email: emailSchema,
    displayName: displayNameSchema.optional(),
    mailboxKind: mailboxKindSchema.optional(),
  })
  .strict();

export const BULK_USER_LIMIT = 50;
export const bulkCreateUsersSchema = z
  .object({
    users: z
      .array(
        z
          .object({ email: z.string().max(320), displayName: displayNameSchema.optional() })
          .strict(),
      )
      .min(1)
      .max(BULK_USER_LIMIT),
  })
  .strict();
export const bulkCreateResultSchema = z.object({
  created: z.number().int(),
  alreadyExisted: z.number().int(),
  invalid: z.array(z.object({ index: z.number().int(), reason: z.string() })),
});
export type BulkCreateResult = z.infer<typeof bulkCreateResultSchema>;

export const updateUserSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    status: userStatusSchema.optional(),
    displayName: displayNameSchema.nullable().optional(),
    mailboxKind: mailboxKindSchema.optional(),
  })
  .strict()
  .refine(
    (v) => v.status !== undefined || v.displayName !== undefined || v.mailboxKind !== undefined,
    { message: 'Provide at least one field to change.' },
  );

export const changeRoleSchema = z
  .object({ role: roleSchema, expectedVersion: z.number().int().min(1) })
  .strict();

export const listUsersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  after: z.string().max(254).optional(),
  status: userStatusSchema.optional(),
  role: roleSchema.optional(),
  q: z.string().trim().min(1).max(40).optional(),
});

export const auditEntrySchema = z.object({
  id: z.string(),
  createdAt: timestampSchema,
  eventType: z.string(),
  outcome: z.string(),
  actorUserId: z.string().nullable(),
  targetUserId: z.string().nullable(),
  requestId: z.string().nullable(),
  details: z.record(z.string(), z.unknown()).nullable(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;
export const auditListSchema = z.object({
  entries: z.array(auditEntrySchema),
  nextCursor: z.string().nullable(),
});
export const listAuditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.coerce.number().int().min(1).optional(),
  eventType: z.string().max(64).optional(),
  targetUserId: z.string().max(64).optional(),
});
