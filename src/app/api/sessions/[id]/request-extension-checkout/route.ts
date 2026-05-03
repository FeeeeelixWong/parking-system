import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import { dailyRate } from "@/lib/rates";
import {
  getOrCreateStripeCustomer,
  createPaymentCheckoutSession,
  stripeConfigured,
} from "@/lib/stripe";
import { handler, json } from "@/lib/api-handler";
import { DenialCode } from "@/types/actions";
import type { TypedDenial } from "@/types/actions";

const ExtensionCheckoutBody = z.object({
  driverId: z.string().min(1),
  days: z.number().int().min(1).max(30),
});

function denial(d: TypedDenial) {
  return json({ ok: false as const, denial: d });
}

export const POST = handler(
  { body: ExtensionCheckoutBody },
  async ({ body, params, req }) => {
    const { driverId, days } = body;
    const sessionId = (params as { id: string }).id;

    if (!stripeConfigured()) {
      return denial({
        code: DenialCode.STRIPE_NOT_CONFIGURED,
        message: "Online payments are not available right now. Contact staff.",
        severity: "warning",
        recoverable: false,
      });
    }

    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: { vehicle: true, driver: true, payments: { select: { type: true } } },
    });

    if (!session || session.driverId !== driverId) {
      return denial({
        code: DenialCode.SESSION_NOT_OWNED,
        message: "Session not found.",
        severity: "critical",
        recoverable: false,
      });
    }

    const effectiveStatus =
      session.status === "OVERSTAY" ||
      (session.status === "ACTIVE" && session.expectedEnd < new Date())
        ? "OVERSTAY"
        : "ACTIVE";

    if (effectiveStatus === "OVERSTAY") {
      return denial({
        code: DenialCode.SESSION_ALREADY_OVERSTAY,
        message: "Your session has already expired. Please settle the overstay fee instead.",
        severity: "warning",
        recoverable: false,
      });
    }

    const isMonthly = session.payments.some(
      (p) => p.type === "MONTHLY_CHECKIN" || p.type === "MONTHLY_RENEWAL",
    );
    if (isMonthly) {
      return denial({
        code: DenialCode.MONTHLY_NO_EXTENSION,
        message: "Monthly subscriptions renew automatically — extensions are not available.",
        severity: "info",
        recoverable: false,
      });
    }

    const settings = await getSettings();
    const vehicleType = session.vehicle.type as "BOBTAIL" | "TRUCK_TRAILER";
    const vLabel = vehicleType === "BOBTAIL" ? "Bobtail" : "Truck/Trailer";
    const plateStr = session.vehicle.licensePlate ? ` (${session.vehicle.licensePlate})` : "";

    const rate = dailyRate(settings, vehicleType);
    const amount = rate * days;
    const description = `${days}d extension — ${vLabel}${plateStr}`;

    const customerId = await getOrCreateStripeCustomer(session.driver);
    const origin = new URL(req.url).origin;

    const checkout = await createPaymentCheckoutSession({
      amount,
      description,
      customerId,
      successUrl: `${origin}/payment-complete?cs={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${origin}/extend`,
      metadata: {
        driverId,
        sessionId,
        sessionPurpose: "EXTENSION",
        days: String(days),
      },
    });

    return json({
      ok: true as const,
      result: {
        checkoutUrl: checkout.checkoutUrl,
        previewAmount: amount,
        description,
      },
    });
  },
);
