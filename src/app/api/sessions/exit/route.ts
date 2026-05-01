import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import { triggerGateOpen } from "@/lib/gate";
import { log as audit } from "@/lib/audit";
import { overstayRate, ceilDays } from "@/lib/rates";
import { handler, json, notFound } from "@/lib/api-handler";
import { SessionExitSchema } from "@/lib/schemas";

/**
 * POST: complete an active session.
 *
 * ACTIVE session → mark COMPLETED, open gate. No payment involved.
 *
 * OVERSTAY session:
 *   - If paymentRequired is true: reject. Client must redirect to
 *     /api/payments/checkout with sessionPurpose=OVERSTAY; the Stripe
 *     webhook (`handleOverstay`) will close the session atomically.
 *   - If paymentRequired is false (dev/test): close session with a
 *     free-mode Payment row recording the owed hours for reporting.
 *
 * The returned shape for the OVERSTAY-rejected case matches OverstayInfo
 * so the /exit page can render the fee screen and redirect to Checkout.
 */
export const POST = handler(
  { body: SessionExitSchema },
  async ({ body }) => {
    const { sessionId, driverId } = body;

    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: { spot: true, vehicle: true },
    });
    if (
      !session ||
      session.driverId !== driverId ||
      !["ACTIVE", "OVERSTAY"].includes(session.status)
    ) {
      throw notFound("No active session found");
    }

    const now = new Date();
    const isOverstayed = now > session.expectedEnd || session.status === "OVERSTAY";

    if (isOverstayed) {
      const settings = await getSettings();
      const rate = overstayRate(settings, session.vehicle.type);
      const overstayDays = ceilDays(session.expectedEnd, now);
      const overstayAmount = rate * overstayDays;

      if (settings.paymentRequired) {
        // Direct the client to the Stripe Checkout flow. /exit page uses
        // this response shape to render the fee screen + "Pay & exit" button.
        return json({
          requiresPayment: true,
          overstayDays,
          overstayAmount,
          overstayRate: rate,
          sessionId: session.id,
        });
      }

      // Free-mode overstay close.
      await prisma.$transaction([
        prisma.payment.create({
          data: {
            sessionId,
            type: "OVERSTAY",
            amount: overstayAmount,
            days: overstayDays,
            legacyQbReference: `free_${randomUUID()}`,
          },
        }),
        prisma.session.update({
          where: { id: sessionId },
          data: { status: "COMPLETED", endedAt: now },
        }),
      ]);
      await audit({
        action: "OVERSTAY_PAYMENT",
        sessionId,
        driverId: session.driverId,
        vehicleId: session.vehicleId,
        details: `Overstay ${overstayDays}d closed (payment disabled), plate: ${session.vehicle.licensePlate}`,
      });
    } else {
      await prisma.session.update({
        where: { id: sessionId },
        data: { status: "COMPLETED", endedAt: now },
      });
    }

    await audit({
      action: "CHECKOUT",
      sessionId,
      driverId: session.driverId,
      vehicleId: session.vehicleId,
      spotId: session.spotId,
      details: `Checked out from spot ${session.spot.label}, plate: ${session.vehicle.licensePlate}`,
    });

    triggerGateOpen();

    return json({ success: true, gateOpened: true });
  },
);
