import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import { sendSMS, sendEmail } from "@/lib/notifications";
import { log as audit } from "@/lib/audit";
import { ceilDays } from "@/lib/rates";

// This endpoint should be called periodically (e.g., every 5 minutes via Vercel Cron or external cron)
export async function GET() {
  const settings = await getSettings();
  const now = new Date();

  // 1. Send expiry reminders to drivers
  const reminderThreshold = new Date(
    now.getTime() + settings.reminderMinutesBefore * 60 * 1000
  );

  const sessionsNeedingReminder = await prisma.session.findMany({
    where: {
      status: "ACTIVE",
      reminderSent: false,
      expectedEnd: { lte: reminderThreshold },
    },
    include: { driver: true, spot: true },
  });

  for (const session of sessionsNeedingReminder) {
    const expiresAt = new Date(session.expectedEnd).toLocaleString();
    // No sessionId in URL — /extend reads the driver's active session from localStorage.
    // Keeps the session token out of SMS/carrier logs.
    const extendUrl = `${process.env.NEXT_PUBLIC_BASE_URL}/extend`;

    const message = `Your parking at spot ${session.spot.label} expires at ${expiresAt}. Extend your time: ${extendUrl}`;

    await sendSMS(session.driver.phone, message);
    if (session.driver.email) {
      await sendEmail(session.driver.email, "Parking Expiry Reminder", message);
    }

    await prisma.session.update({
      where: { id: session.id },
      data: { reminderSent: true },
    });

    await audit({
      action: "REMINDER_SENT",
      sessionId: session.id,
      driverId: session.driverId,
      spotId: session.spotId,
      details: `Expiry reminder sent to ${session.driver.name} (${session.driver.phone}) — spot ${session.spot.label}`,
    });
  }

  // 2. Flip ACTIVE → OVERSTAY for sessions past the grace period
  const graceThreshold = new Date(
    now.getTime() - settings.gracePeriodMinutes * 60 * 1000
  );

  const overstayedSessions = await prisma.session.findMany({
    where: {
      status: "ACTIVE",
      expectedEnd: { lte: graceThreshold },
      // Skip sessions whose Stripe subscription is in the dunning retry window.
      // invoice.payment_succeeded will reset billingStatus to CURRENT on success;
      // customer.subscription.deleted sets DELINQUENT (which is NOT skipped here
      // because expectedEnd is already clamped to now at that point).
      billingStatus: { not: "PAYMENT_FAILED" },
    },
    include: { driver: true, spot: true },
  });

  if (overstayedSessions.length > 0) {
    await prisma.session.updateMany({
      where: { id: { in: overstayedSessions.map((s) => s.id) }, status: "ACTIVE" },
      data: { status: "OVERSTAY" },
    });

    await Promise.all(
      overstayedSessions.map((s) =>
        audit({
          action: "OVERSTAY_START",
          sessionId: s.id,
          driverId: s.driverId,
          spotId: s.spotId,
          details: `Overstay began at spot ${s.spot.label} — ${s.driver.name} (${s.driver.phone})`,
        })
      )
    );
  }

  // 3. Escalate PAYMENT_FAILED → DELINQUENT when the grace period has elapsed.
  //    Only runs when the admin has configured the "after_grace_days" policy.
  if (settings.failedPaymentPolicy === "after_grace_days") {
    const graceMs = settings.failedPaymentGraceDays * 24 * 60 * 60 * 1000;
    const billingGraceThreshold = new Date(now.getTime() - graceMs);
    const toEscalate = await prisma.session.findMany({
      where: {
        billingStatus: "PAYMENT_FAILED",
        billingFailedAt: { lte: billingGraceThreshold },
      },
      select: { id: true, driverId: true },
    });
    if (toEscalate.length > 0) {
      await prisma.session.updateMany({
        where: { id: { in: toEscalate.map((s) => s.id) } },
        data: { billingStatus: "DELINQUENT", billingDelinquentAt: now },
      });
      await Promise.all(
        toEscalate.map((s) =>
          audit({
            action: "SUBSCRIPTION_CANCELED",
            sessionId: s.id,
            driverId: s.driverId,
            details: `Grace period (${settings.failedPaymentGraceDays}d) elapsed — escalated PAYMENT_FAILED → DELINQUENT`,
          })
        )
      );
    }
  }

  // 4. Notify manager — only for sessions whose alert has NOT been sent yet.
  // This prevents duplicate alerts when the cron runs multiple times before
  // a driver exits.
  const unalertedOverstays = await prisma.session.findMany({
    where: {
      status: "OVERSTAY",
      overstayAlertSent: false,
    },
    include: { driver: true, spot: true },
  });

  if (unalertedOverstays.length > 0 && settings.managerEmail) {
    const lines = unalertedOverstays.map((s) => {
      const overDays = ceilDays(new Date(s.expectedEnd), now);
      return `- Spot ${s.spot.label}: ${s.driver.name} (${s.driver.phone}) — ${overDays}d overstay`;
    });

    const body = `The following vehicles have overstayed:\n\n${lines.join("\n")}`;

    await sendEmail(settings.managerEmail, "Overstay Alert", body);

    if (settings.managerPhone) {
      await sendSMS(settings.managerPhone, `Overstay alert: ${unalertedOverstays.length} vehicle(s) past time. Check dashboard.`);
    }

    // Mark alerts as sent so we don't re-notify on next cron run
    await prisma.session.updateMany({
      where: { id: { in: unalertedOverstays.map((s) => s.id) } },
      data: { overstayAlertSent: true },
    });

    await audit({
      action: "OVERSTAY_ALERT",
      details: `Manager notified: ${unalertedOverstays.length} vehicle(s) overstayed — ${settings.managerEmail}`,
    });
  }

  return NextResponse.json({
    remindersSent: sessionsNeedingReminder.length,
    overstayAlerts: unalertedOverstays.length,
  });
}
