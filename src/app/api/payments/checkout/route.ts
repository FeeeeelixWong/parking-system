import { prisma } from "@/lib/prisma";
import {
  getOrCreateStripeCustomer,
  createPaymentCheckoutSession,
  createSubscriptionCheckoutSession,
  stripeConfigured,
} from "@/lib/stripe";
import { handler, json, notFound, conflict } from "@/lib/api-handler";
import { CheckoutCreateSchema } from "@/lib/schemas";
import { getSettings } from "@/lib/settings";
import { dailyRate, monthlyRate } from "@/lib/rates";

/**
 * POST /api/payments/checkout — create a Stripe Checkout session for initial
 * check-in (CHECKIN one-time, MONTHLY_CHECKIN subscription).
 *
 * Extension and overstay checkouts are created through the session command
 * endpoints: POST /api/sessions/[id]/request-extension-checkout and
 * POST /api/sessions/[id]/request-overstay-checkout.
 *
 * Amount and description are computed server-side from current settings rates.
 * The client never sends a dollar figure — that prevents price tampering.
 */
export const POST = handler(
  { body: CheckoutCreateSchema },
  async ({ body, req }) => {
    if (!stripeConfigured()) {
      throw conflict("Stripe is not configured. Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.");
    }

    const { driverId, sessionPurpose, vehicleId, days, months, termsVersion } = body;

    if (!vehicleId) {
      return json({ error: "vehicleId is required for check-in" }, { status: 400 });
    }
    if (sessionPurpose === "CHECKIN" && !days) {
      return json({ error: "days is required for CHECKIN" }, { status: 400 });
    }
    if (sessionPurpose === "MONTHLY_CHECKIN" && !months) {
      return json({ error: "months is required for MONTHLY_CHECKIN" }, { status: 400 });
    }

    const driver = await prisma.driver.findUnique({ where: { id: driverId } });
    if (!driver) throw notFound("Driver not found");

    const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
    if (!vehicle || vehicle.driverId !== driverId) {
      throw notFound("Vehicle not found");
    }

    const licensePlate = vehicle.licensePlate ?? undefined;
    const vehicleType = vehicle.type as "BOBTAIL" | "TRUCK_TRAILER";

    if (sessionPurpose === "MONTHLY_CHECKIN" && vehicleType === "BOBTAIL") {
      return json({ error: "Monthly parking is not available for bobtail vehicles." }, { status: 400 });
    }

    // Compute amount + description server-side from current settings rates.
    const settings = await getSettings();
    const plateStr = licensePlate ? ` — plate ${licensePlate}` : "";
    const vLabel = vehicleType === "BOBTAIL" ? "Bobtail" : "Truck/trailer";

    let amount: number;
    let description: string;

    if (sessionPurpose === "CHECKIN") {
      amount = dailyRate(settings, vehicleType) * days!;
      description = `${vLabel} parking — ${days}d${plateStr}`;
    } else {
      amount = monthlyRate(settings, vehicleType) * months!;
      description = `${vLabel} parking — ${months} month${months! > 1 ? "s" : ""}${plateStr}`;
    }

    const customerId = await getOrCreateStripeCustomer(driver);

    const metadata = {
      driverId,
      vehicleId,
      sessionPurpose,
      ...(days !== undefined ? { days: String(days) } : {}),
      ...(months !== undefined ? { months: String(months) } : {}),
      ...(termsVersion ? { termsVersion } : {}),
      ...(licensePlate ? { licensePlate } : {}),
      vehicleType,
    };

    // Resolve success/cancel URLs against the incoming request origin so
    // localhost and deployed URLs both work without env-var coordination.
    const origin = new URL(req.url).origin;
    const successUrl = `${origin}/payment-complete?cs={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${origin}/checkin`;

    const result = sessionPurpose === "MONTHLY_CHECKIN"
      ? await createSubscriptionCheckoutSession({
          monthlyAmount: amount,
          productName: description,
          customerId,
          months: months!,
          successUrl,
          cancelUrl,
          metadata,
        })
      : await createPaymentCheckoutSession({
          amount,
          description,
          customerId,
          successUrl,
          cancelUrl,
          metadata,
        });

    return json(result);
  },
);
