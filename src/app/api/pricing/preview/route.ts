import { getSettings } from "@/lib/settings";
import { dailyRate, monthlyRate } from "@/lib/rates";
import { PricingPreviewQuerySchema } from "@/lib/schemas";
import { handler, json } from "@/lib/api-handler";
import { DenialCode } from "@/types/actions";

export const GET = handler(
  { query: PricingPreviewQuerySchema },
  async ({ query }) => {
    const { vehicleType, durationType, days, months } = query;

    if (durationType === "MONTHLY" && vehicleType === "BOBTAIL") {
      return json({
        ok: false,
        denial: {
          code: DenialCode.BOBTAIL_MONTHLY_NOT_ALLOWED,
          message: "Monthly pricing is not available for bobtail vehicles.",
          severity: "info" as const,
          recoverable: true,
        },
      });
    }

    const settings = await getSettings();

    if (durationType === "DAILY") {
      const qty = days!;
      const rate = dailyRate(settings, vehicleType);
      const total = rate * qty;
      return json({
        ok: true,
        result: {
          vehicleType,
          durationType,
          quantity: qty,
          rate,
          totalAmount: total,
          description: `${qty} day${qty === 1 ? "" : "s"} parking — ${vehicleType === "BOBTAIL" ? "Bobtail" : "Truck/Trailer"}`,
          termsVersion: settings.termsVersion,
        },
      });
    }

    // MONTHLY
    const qty = months!;
    const rate = monthlyRate(settings, vehicleType);
    const total = rate * qty;
    return json({
      ok: true,
      result: {
        vehicleType,
        durationType,
        quantity: qty,
        rate,
        totalAmount: total,
        description: `${qty} month${qty === 1 ? "" : "s"} parking — ${vehicleType === "BOBTAIL" ? "Bobtail" : "Truck/Trailer"}`,
        termsVersion: settings.termsVersion ?? "v1",
      },
    });
  },
);
