/**
 * Shared action/denial types — safe for both server routes and client bundles.
 * No server-only imports.
 */

export type ActionCode =
  | "OPEN_GATE"
  | "START_CHECKIN"
  | "REQUEST_EXTENSION_CHECKOUT"
  | "REQUEST_OVERSTAY_CHECKOUT"
  | "VIEW_SESSION"
  | "CONTACT_ADMIN";

export type ActionState = {
  code: ActionCode;
  enabled: boolean;
  label: string;
  reason?: string;
  href?: string;
};

export type TypedDenial = {
  code: string;
  message: string;
  severity: "info" | "warning" | "critical";
  recoverable: boolean;
};

export const DenialCode = {
  RESCAN_REQUIRED: "RESCAN_REQUIRED",
  SESSION_OVERSTAY: "SESSION_OVERSTAY",
  SESSION_NOT_ACTIVE: "SESSION_NOT_ACTIVE",
  SESSION_NOT_OWNED: "SESSION_NOT_OWNED",
  SUSPICIOUS_ENTRY: "SUSPICIOUS_ENTRY",
  NOT_ON_ALLOWLIST: "NOT_ON_ALLOWLIST",
  MONTHLY_NO_EXTENSION: "MONTHLY_NO_EXTENSION",
  SESSION_ALREADY_OVERSTAY: "SESSION_ALREADY_OVERSTAY",
  STRIPE_NOT_CONFIGURED: "STRIPE_NOT_CONFIGURED",
  LOT_FULL: "LOT_FULL",
  NO_DRIVER_FOUND: "NO_DRIVER_FOUND",
  BOBTAIL_MONTHLY_NOT_ALLOWED: "BOBTAIL_MONTHLY_NOT_ALLOWED",
  SUBSCRIPTION_DELINQUENT: "SUBSCRIPTION_DELINQUENT",
} as const;

export type DenialCodeType = (typeof DenialCode)[keyof typeof DenialCode];

export type AdminMutationResult = {
  ok: true;
  result: {
    dbEffects: string[];
    stripeEffects: string[];
    quickbooksEffects: string[];
    accessEffects: string[];
    auditLogId?: string;
    needsReconcile: boolean;
  };
};
