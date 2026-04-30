import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { triggerGateOpen } from "@/lib/gate";
import { log as audit } from "@/lib/audit";
import { handler, json } from "@/lib/api-handler";

const GateOpenBody = z
  .object({
    sessionId: z.string().min(1).optional(),
    allowListPhone: z.string().min(4).optional(),
    driverId: z.string().min(1).optional(),
    deviceId: z.string().optional(),
    direction: z.enum(["ENTRANCE", "EXIT"]).optional(),
  })
  .refine((d) => d.allowListPhone || (d.sessionId && d.driverId), {
    message: "Must provide allowListPhone, OR both sessionId and driverId",
  });

/** Log a gate denial and return 403. */
async function deny(
  reason: string,
  ctx: { sessionId?: string; driverId?: string; deviceId?: string; direction?: string },
) {
  const dirLabel = ctx.direction === "EXIT" ? "exit" : "entrance";
  await audit({
    action: "GATE_DENIED",
    sessionId: ctx.sessionId,
    driverId: ctx.driverId,
    details: [
      `Gate ${dirLabel} denied: ${reason}`,
      ctx.deviceId ? `device:${ctx.deviceId.slice(0, 8)}` : null,
    ].filter(Boolean).join(" — "),
  }).catch(() => {}); // best-effort logging
  return json({ success: false, error: reason }, { status: 403 });
}

export const POST = handler({ body: GateOpenBody }, async ({ body }) => {
  const { sessionId, allowListPhone, driverId, deviceId, direction } = body;
  const ctx = { sessionId, driverId, deviceId, direction };

  // ── Allow list path — no session required ──
  if (allowListPhone) {
    const phone = allowListPhone.replace(/\D/g, "");
    const entry = await prisma.allowList.findUnique({ where: { phone } });
    if (!entry || !entry.active) {
      return deny("Not on allow list", { ...ctx, sessionId: undefined });
    }
    const result = await triggerGateOpen();
    const dirLabel = direction === "EXIT" ? "exit" : "entrance";
    await audit({
      action: "ALLOWLIST_ENTRY",
      details: [
        `Allow list ${dirLabel}: ${entry.name} (${entry.label})`,
        deviceId ? `device:${deviceId.slice(0, 8)}` : null,
      ].filter(Boolean).join(" — "),
    });
    return json({ ...result, allowList: true, openedAt: new Date().toISOString() });
  }

  // ── Session validation ──
  // refine() above guarantees both sessionId and driverId are present here
  if (!sessionId || !driverId) {
    return deny("Session ID and driver ID required", ctx);
  }

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { id: true, status: true, driverId: true, expectedEnd: true },
  });

  if (!session) {
    return deny("No session found", ctx);
  }

  // Ownership check — always enforced, never optional
  if (session.driverId !== driverId) {
    return deny("Session does not belong to this driver", ctx);
  }

  if (!["ACTIVE", "OVERSTAY"].includes(session.status)) {
    return deny("Session is not active", ctx);
  }

  if (direction === "ENTRANCE" && session.status === "OVERSTAY") {
    return deny("Session expired — settle overstay first", ctx);
  }

  // ── Suspicious entry detection — must run before hardware opens ──
  // Two consecutive ENTRANCE scans from different devices on the same
  // session means someone cloned the QR or shared a screenshot. Deny
  // here so the gate never opens for the suspicious request.
  if (direction === "ENTRANCE" && deviceId) {
    try {
      const recentGateEvents = await prisma.auditLog.findMany({
        where: { sessionId, action: "GATE_OPEN" },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { details: true },
      });

      if (recentGateEvents.length === 1) {
        const prevDetails = recentGateEvents[0].details ?? "";
        const prevWasEntrance = prevDetails.includes("Gate entrance");
        const prevDeviceMatch = prevDetails.match(/device:(\w+)/);
        const prevDevicePrefix = prevDeviceMatch?.[1];
        const currentDevicePrefix = deviceId.slice(0, 8);

        if (prevWasEntrance && prevDevicePrefix && prevDevicePrefix !== currentDevicePrefix) {
          await audit({
            action: "SUSPICIOUS_ENTRY",
            sessionId,
            driverId: driverId ?? session.driverId,
            details: `BLOCKED — double entrance from different devices: device:${currentDevicePrefix} after device:${prevDevicePrefix}`,
          });
          return deny(
            "Entry blocked — this session was already scanned from a different device. Contact staff if this is an error.",
            { ...ctx, driverId: driverId ?? session.driverId }
          );
        }
      }
    } catch {
      // Detection failed — fail-open for safety (legitimate driver not blocked)
    }
  }

  // ── Gate opens ──
  const result = await triggerGateOpen();

  const dirLabel = direction === "EXIT" ? "Exit" : "Entrance";
  const details = [
    `Gate ${dirLabel.toLowerCase()} via QR scan`,
    deviceId ? `device:${deviceId.slice(0, 8)}` : null,
  ].filter(Boolean).join(" — ");

  await audit({
    action: "GATE_OPEN",
    driverId: driverId ?? session.driverId,
    sessionId,
    details,
  });

  return json({ ...result, openedAt: new Date().toISOString() });
});
