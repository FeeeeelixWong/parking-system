import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import { computeOverstayFee } from "@/lib/rates";
import { countFreeSpots } from "@/lib/spots";
import { handler, json } from "@/lib/api-handler";
import { DriverStateQuerySchema } from "@/lib/schemas";
import { RATE_LIMITS } from "@/lib/rate-limit";
import type { ActionState, TypedDenial } from "@/types/actions";
import { DenialCode } from "@/types/actions";

export const GET = handler(
  { query: DriverStateQuerySchema, rateLimit: RATE_LIMITS.auth },
  async ({ query }) => {
    const phone = query.phone.replace(/\D/g, "");

    // ── Allow list ──
    const allowEntry = await prisma.allowList.findUnique({ where: { phone } });
    const allowList = allowEntry?.active
      ? { allowed: true, name: allowEntry.name, label: allowEntry.label }
      : { allowed: false };

    // Short-circuit for allow-listed entries — no session or driver needed
    if (allowList.allowed) {
      return json({
        driver: null,
        allowList,
        activeSessions: [],
        overstayPreview: null,
        availability: null,
        gateEligibility: { entrance: true, exit: false, blockedReason: undefined },
        allowedActions: [
          { code: "OPEN_GATE", enabled: true, label: "Open Gate" },
        ] satisfies ActionState[],
        denials: [],
      });
    }

    // ── Driver lookup ──
    const driver = await prisma.driver.findFirst({
      where: { phone },
      select: { id: true, name: true, phone: true, email: true },
    });

    const settings = await getSettings();
    const [freeSpots, activeSessions] = await Promise.all([
      countFreeSpots(),
      driver
        ? prisma.session.findMany({
            where: { driverId: driver.id, status: { in: ["ACTIVE", "OVERSTAY"] } },
            include: {
              spot: true,
              vehicle: true,
              payments: { select: { id: true, type: true } },
            },
            orderBy: { startedAt: "desc" },
          })
        : Promise.resolve([]),
    ]);

    // ── Spot availability ──
    const bobtailEffective = freeSpots.bobtail + (settings.bobtailOverflow ? freeSpots.truck : 0);
    const availability = {
      bobtailFree: freeSpots.bobtail,
      truckFree: freeSpots.truck,
      overflowEnabled: settings.bobtailOverflow,
      bobtailEffective,
      truckEffective: freeSpots.truck,
    };

    if (!driver) {
      return json({
        driver: null,
        allowList,
        activeSessions: [],
        overstayPreview: null,
        availability,
        gateEligibility: { entrance: false, exit: false, blockedReason: "No account found" },
        allowedActions: [
          { code: "START_CHECKIN", enabled: true, label: "Check In", href: "/checkin" },
        ] satisfies ActionState[],
        denials: [
          {
            code: DenialCode.NO_DRIVER_FOUND,
            message: "No account found for this phone number.",
            severity: "info",
            recoverable: true,
          },
        ] satisfies TypedDenial[],
      });
    }

    // ── Effective status — treat ACTIVE sessions past expectedEnd as OVERSTAY
    // even if the cron job hasn't flipped the DB row yet.
    const now = new Date();
    const sessionsWithEffectiveStatus = activeSessions.map((s) => ({
      ...s,
      effectiveStatus: (s.status === "OVERSTAY" || (s.status === "ACTIVE" && s.expectedEnd < now)
        ? "OVERSTAY"
        : "ACTIVE") as "ACTIVE" | "OVERSTAY",
    }));

    // ── Overstay preview ──
    const overstaySessions = sessionsWithEffectiveStatus.filter(
      (s) => s.effectiveStatus === "OVERSTAY",
    );
    let overstayPreview: {
      sessionId: string;
      overstayDays: number;
      overstayAmount: number;
      overstayRate: number;
    } | null = null;

    if (overstaySessions.length > 0) {
      const os = overstaySessions[0];
      const fee = computeOverstayFee(
        { expectedEnd: os.expectedEnd, vehicle: { type: os.vehicle.type } },
        settings,
      );
      overstayPreview = { sessionId: os.id, ...fee };
    }

    // ── Monthly detection ──
    const hasMonthly = sessionsWithEffectiveStatus.some((s) =>
      s.payments.some((p) => p.type === "MONTHLY_CHECKIN" || p.type === "MONTHLY_RENEWAL"),
    );

    // ── Build allowed actions and gate eligibility ──
    const allowedActions: ActionState[] = [];
    const denials: TypedDenial[] = [];

    const hasActive = sessionsWithEffectiveStatus.some((s) => s.effectiveStatus === "ACTIVE");
    const hasOverstay = overstaySessions.length > 0;

    if (hasOverstay) {
      allowedActions.push({
        code: "OPEN_GATE",
        enabled: false,
        label: "Open Gate",
        reason: "Settle overstay first",
      });
      allowedActions.push({
        code: "REQUEST_OVERSTAY_CHECKOUT",
        enabled: true,
        label: "Pay Overstay & Exit",
      });
      denials.push({
        code: DenialCode.SESSION_OVERSTAY,
        message: "Your session has expired. Please settle the overstay fee to open the exit gate.",
        severity: "warning",
        recoverable: true,
      });
    } else if (hasActive) {
      allowedActions.push({
        code: "OPEN_GATE",
        enabled: true,
        label: "Open Gate",
      });
      allowedActions.push({
        code: "REQUEST_EXTENSION_CHECKOUT",
        enabled: !hasMonthly,
        label: "Extend Stay",
        reason: hasMonthly ? "Monthly subscriptions renew automatically" : undefined,
      });
    } else {
      // No active session
      const noTruckSpots = freeSpots.truck === 0;
      const noBobtailSpots = bobtailEffective === 0;
      const lotFull = noTruckSpots && noBobtailSpots;

      allowedActions.push({
        code: "START_CHECKIN",
        enabled: !lotFull,
        label: "Check In",
        href: lotFull ? undefined : "/checkin",
        reason: lotFull ? "Lot is full" : undefined,
      });
      allowedActions.push({
        code: "OPEN_GATE",
        enabled: false,
        label: "Open Gate",
        reason: "No active session",
      });

      if (lotFull) {
        denials.push({
          code: DenialCode.LOT_FULL,
          message: "The lot is currently full. Please check back later.",
          severity: "warning",
          recoverable: false,
        });
      }
    }

    const gateEligibility = {
      entrance: hasActive && !hasOverstay,
      exit: hasActive || hasOverstay,
      blockedReason: hasOverstay ? "Settle overstay first" : undefined,
    };

    // Serialize sessions to the wire shape (strip DB internals)
    const wireActiveSessions = sessionsWithEffectiveStatus.map((s) => ({
      id: s.id,
      status: s.effectiveStatus,
      expectedEnd: s.expectedEnd.toISOString(),
      startedAt: s.startedAt.toISOString(),
      spot: { label: s.spot.label, type: s.spot.type },
      vehicle: {
        id: s.vehicle.id,
        licensePlate: s.vehicle.licensePlate,
        unitNumber: s.vehicle.unitNumber,
        type: s.vehicle.type,
        nickname: s.vehicle.nickname,
      },
      isMonthly: s.payments.some((p) => p.type === "MONTHLY_CHECKIN" || p.type === "MONTHLY_RENEWAL"),
    }));

    return json({
      driver: { id: driver.id, name: driver.name, phone: driver.phone, email: driver.email },
      allowList,
      activeSessions: wireActiveSessions,
      overstayPreview,
      availability,
      gateEligibility,
      allowedActions,
      denials,
    });
  },
);
