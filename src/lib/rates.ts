/**
 * Rate selection and overstay calculation helpers.
 *
 * Centralises the vehicle-type → rate lookup and overstay duration math
 * so they aren't duplicated across API routes and frontend pages.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Add `days` to a base Date and return the new Date. */
export function addDays(base: Date, days: number): Date {
  return new Date(base.getTime() + days * MS_PER_DAY);
}

/** Milliseconds between two dates, floored at 0. */
export function msBetween(start: Date, end: Date): number {
  return Math.max(0, end.getTime() - start.getTime());
}

/** Whole days (rounded up) between two dates. */
export function ceilDays(start: Date, end: Date): number {
  return Math.ceil(msBetween(start, end) / MS_PER_DAY);
}

type RateSettings = {
  dailyRateBobtail: number;
  dailyRateTruck: number;
  monthlyRateBobtail: number;
  monthlyRateTruck: number;
  overstayRateBobtail: number;
  overstayRateTruck: number;
};

type VehicleType = "BOBTAIL" | "TRUCK_TRAILER";

/** Look up the standard daily rate for a vehicle type. */
export function dailyRate(settings: RateSettings, vehicleType: VehicleType): number {
  return vehicleType === "BOBTAIL"
    ? settings.dailyRateBobtail
    : settings.dailyRateTruck;
}

/** Look up the monthly rate for a vehicle type. */
export function monthlyRate(settings: RateSettings, vehicleType: VehicleType): number {
  return vehicleType === "BOBTAIL"
    ? settings.monthlyRateBobtail
    : settings.monthlyRateTruck;
}

/** Look up the overstay (premium) daily rate for a vehicle type. */
export function overstayRate(settings: RateSettings, vehicleType: VehicleType): number {
  return vehicleType === "BOBTAIL"
    ? settings.overstayRateBobtail
    : settings.overstayRateTruck;
}

/** Add `months` to a base Date and return the new Date. */
export function addMonths(base: Date, months: number): Date {
  const targetMonthIndex = base.getMonth() + months;
  const targetYear = base.getFullYear() + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  const lastDayOfTargetMonth = new Date(targetYear, targetMonth + 1, 0).getDate();

  return new Date(
    targetYear,
    targetMonth,
    Math.min(base.getDate(), lastDayOfTargetMonth),
    base.getHours(),
    base.getMinutes(),
    base.getSeconds(),
    base.getMilliseconds(),
  );
}

/** Compute the overstay fee preview given a session and current settings. */
export function computeOverstayFee(
  session: { expectedEnd: Date; vehicle: { type: string } },
  settings: RateSettings,
): { overstayDays: number; overstayAmount: number; overstayRate: number } {
  const rate = overstayRate(settings, session.vehicle.type as VehicleType);
  const days = ceilDays(session.expectedEnd, new Date());
  return { overstayDays: days, overstayAmount: rate * days, overstayRate: rate };
}
