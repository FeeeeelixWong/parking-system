import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import { computeOverstayFee } from "@/lib/rates";
import {
  getOrCreateStripeCustomer,
  createPaymentCheckoutSession,
  stripeConfigured,
} from "@/lib/stripe";
import { handler, json } from "@/lib/api-handler";
import { DenialCode } from "@/types/actions";
import type { TypedDenial } from "@/types/actions";

const OverstayCheckoutBody = z.object({
  driverId: z.string().min(1),
});

function denial(d: TypedDenial) {
  return json({ ok: false as const, denial: d });
}

export const POST = handler(
  { body: OverstayCheckoutBody },
  async ({ body, params, req }) => {
    const { driverId } = body;
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
      include: { vehicle: true, driver: true },
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

    if (effectiveStatus !== "OVERSTAY") {
      return denial({
        code: DenialCode.SESSION_NOT_ACTIVE,
        message: "This session is not in overstay.",
        severity: "info",
        recoverable: false,
      });
    }

    const settings = await getSettings();
    const fee = computeOverstayFee(
      { expectedEnd: session.expectedEnd, vehicle: { type: session.vehicle.type } },
      settings,
    );

    const vehicleType = session.vehicle.type as "BOBTAIL" | "TRUCK_TRAILER";
    const vLabel = vehicleType === "BOBTAIL" ? "Bobtail" : "Truck/Trailer";
    const plateStr = session.vehicle.licensePlate ? ` (${session.vehicle.licensePlate})` : "";
    const description = `Overstay fee — ${fee.overstayDays}d${plateStr} — ${vLabel}`;

    const customerId = await getOrCreateStripeCustomer(session.driver);
    const origin = new URL(req.url).origin;

    const checkout = await createPaymentCheckoutSession({
      amount: fee.overstayAmount,
      description,
      customerId,
      successUrl: `${origin}/payment-complete?cs={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${origin}/exit`,
      metadata: {
        driverId,
        sessionId,
        sessionPurpose: "OVERSTAY",
        overstayAuthorized: "true",
      },
    });

    return json({
      ok: true as const,
      result: {
        checkoutUrl: checkout.checkoutUrl,
        overstayDays: fee.overstayDays,
        overstayAmount: fee.overstayAmount,
      },
    });
  },
);
