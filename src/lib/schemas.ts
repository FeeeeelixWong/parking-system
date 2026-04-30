import { z } from "zod";

// ---------------------------------------------------------------------------
// Primitive schemas
// ---------------------------------------------------------------------------
export const VehicleTypeSchema = z.enum(["BOBTAIL", "TRUCK_TRAILER"]);
export const SessionStatusSchema = z.enum(["ACTIVE", "COMPLETED", "OVERSTAY", "CANCELLED"]);
export const PaymentTypeSchema = z.enum([
  "CHECKIN",
  "MONTHLY_CHECKIN",
  "MONTHLY_RENEWAL",
  "EXTENSION",
  "OVERSTAY",
]);
export const PaymentStatusSchema = z.enum([
  "PENDING", "COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED", "VOIDED", "DISPUTED",
]);
export const AllowListLabelSchema = z.enum(["EMPLOYEE", "FAMILY", "VENDOR", "CONTRACTOR"]);

export const idSchema = z.string().min(1, "required").max(200);
export const emailSchema = z.string().email().max(200);
export const phoneSchema = z
  .string()
  .min(7, "phone too short")
  .max(30, "phone too long");
export const nameSchema = z.string().trim().min(1, "required").max(120);

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------
export const DriverUpsertSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  phone: phoneSchema,
});
export type DriverUpsertInput = z.infer<typeof DriverUpsertSchema>;

export const DriverLookupSchema = z
  .object({
    email: emailSchema.optional(),
    phone: phoneSchema.optional(),
  })
  .refine((d) => d.email || d.phone, {
    message: "email or phone required",
  });

// ---------------------------------------------------------------------------
// Vehicle
// ---------------------------------------------------------------------------
export const VehicleUpsertSchema = z
  .object({
    driverId: idSchema,
    type: VehicleTypeSchema,
    unitNumber: z.string().trim().max(50).optional().nullable(),
    licensePlate: z.string().trim().max(20).optional().nullable(),
    nickname: z.string().trim().max(80).optional().nullable(),
  })
  .refine((d) => !!d.unitNumber || !!d.licensePlate, {
    message: "unitNumber or licensePlate required",
    path: ["unitNumber"],
  });
export type VehicleUpsertInput = z.infer<typeof VehicleUpsertSchema>;

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------
export const SessionCreateSchema = z
  .object({
    driverId: idSchema,
    vehicleId: idSchema,
    durationType: z.enum(["DAILY", "MONTHLY"]).default("DAILY"),
    days: z.number().int().min(1).max(30).optional(),
    months: z.number().int().min(1).max(12).optional(),
    paymentId: z.string().min(1).max(200).optional(),
    // Clickwrap consent — required for new sessions
    termsVersion: z.string().min(1).max(50),
    overstayAuthorized: z.boolean().refine((v) => v === true, {
      message: "Overstay authorization required",
    }),
  })
  .refine(
    (d) =>
      (d.durationType === "DAILY" && d.days != null) ||
      (d.durationType === "MONTHLY" && d.months != null),
    { message: "days required for DAILY, months required for MONTHLY" },
  );
export type SessionCreateInput = z.infer<typeof SessionCreateSchema>;

export const SessionExtendSchema = z.object({
  sessionId: idSchema,
  driverId: idSchema,
  days: z.number().int().min(1).max(30),
  paymentId: z.string().min(1).max(200),
});

export const SessionExitSchema = z.object({
  sessionId: idSchema,
  driverId: idSchema,
  overstayPaymentId: z.string().min(1).max(200).optional(),
});

// ---------------------------------------------------------------------------
// Payment — Stripe Checkout
// ---------------------------------------------------------------------------

/**
 * Body for POST /api/payments/checkout — creates a Stripe Checkout session
 * in either payment mode (one-time) or subscription mode (monthly). Echoes
 * the metadata back on the webhook so the handler knows how to wire the
 * resulting Payment row to a Session.
 */
export const CheckoutCreateSchema = z.object({
  driverId: idSchema,
  sessionPurpose: z.enum(["CHECKIN", "MONTHLY_CHECKIN", "EXTENSION", "OVERSTAY"]),
  // Required for CHECKIN / MONTHLY_CHECKIN — identifies the vehicle that
  // will hold the spot.
  vehicleId: idSchema.optional(),
  // Required for EXTENSION / OVERSTAY — identifies the existing session.
  sessionId: idSchema.optional(),
  // Amount and description are computed server-side from settings rates —
  // never accepted from the client to prevent price tampering.
  days: z.number().int().min(1).max(365).optional(),
  months: z.number().int().min(1).max(12).optional(),
  termsVersion: z.string().min(1).max(50).optional(),
  overstayAuthorized: z.boolean().optional(),
});
export type CheckoutCreateInput = z.infer<typeof CheckoutCreateSchema>;

/**
 * Body for POST /api/admin/refund — triggers a Stripe refund. The webhook
 * (charge.refunded) updates the Payment row and writes the QB Refund Receipt;
 * this route doesn't mutate the DB itself.
 */
export const AdminRefundSchema = z.object({
  paymentId: idSchema,
  // Dollars. Omit for full refund.
  amount: z.number().min(0.01).max(10000).optional(),
  reason: z.enum(["duplicate", "fraudulent", "requested_by_customer"]).optional(),
});
export type AdminRefundInput = z.infer<typeof AdminRefundSchema>;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
export const SettingsUpdateSchema = z.object({
  dailyRateBobtail: z.number().min(0.01, "Rate must be at least $0.01").max(1000).optional(),
  dailyRateTruck: z.number().min(0.01, "Rate must be at least $0.01").max(1000).optional(),
  overstayRateBobtail: z.number().min(0.01, "Rate must be at least $0.01").max(1000).optional(),
  overstayRateTruck: z.number().min(0.01, "Rate must be at least $0.01").max(1000).optional(),
  gracePeriodMinutes: z.number().int().min(0).max(1440).optional(),
  reminderMinutesBefore: z.number().int().min(0).max(1440).optional(),
  totalSpotsBobtail: z.number().int().min(0).max(10000).optional(),
  totalSpotsTruck: z.number().int().min(0).max(10000).optional(),
  managerEmail: z.string().email().max(200).optional().or(z.literal("")),
  managerPhone: phoneSchema.optional().or(z.literal("")),
});

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------
export const SpotOverrideSchema = z.object({
  spotId: idSchema,
  action: z.enum(["free"]),
  reason: z.string().trim().min(1, "reason required").max(500),
});

// ---------------------------------------------------------------------------
// Audit query
// ---------------------------------------------------------------------------
export const AuditActionSchema = z.enum([
  "CHECKIN", "CHECKOUT", "EXTEND",
  "OVERSTAY_START", "OVERSTAY_PAYMENT",
  "GATE_OPEN", "SPOT_FREED",
  "REMINDER_SENT", "OVERSTAY_ALERT",
  "SUSPICIOUS_ENTRY",
  "GATE_DENIED",
  "ALLOWLIST_ENTRY",
  "STRIPE_WEBHOOK_RECEIVED", "STRIPE_WEBHOOK_REPLAYED",
  "SALES_RECEIPT_WRITTEN", "SALES_RECEIPT_FAILED",
  "REFUND_ISSUED", "PAYMENT_DISPUTED",
  "SUBSCRIPTION_CREATED", "SUBSCRIPTION_CANCELED",
]);

export const AuditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  action: AuditActionSchema.optional(),
  vehicleId: idSchema.optional(),
  driverId: idSchema.optional(),
  spotId: idSchema.optional(),
});

// ---------------------------------------------------------------------------
// Session history query
// ---------------------------------------------------------------------------
export const SessionHistoryQuerySchema = z.object({
  driverId: idSchema.optional(),
  vehicleId: idSchema.optional(),
  spotId: idSchema.optional(),
  licensePlate: z.string().trim().max(20).optional(),
  spotLabel: z.string().trim().max(20).optional(),
  status: SessionStatusSchema.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  // search across name/plate/phone/spot
  q: z.string().trim().max(120).optional(),
});
export type SessionHistoryQuery = z.infer<typeof SessionHistoryQuerySchema>;
