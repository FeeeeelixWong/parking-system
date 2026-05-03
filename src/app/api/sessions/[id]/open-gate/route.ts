import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { triggerGateOpen, checkSuspiciousEntry } from "@/lib/gate";
import { log as audit } from "@/lib/audit";
import { handler, json } from "@/lib/api-handler";
import { DenialCode } from "@/types/actions";
import type { TypedDenial } from "@/types/actions";

const OpenGateBody = z.object({
  driverId: z.string().min(1),
  deviceId: z.string().optional(),
  direction: z.enum(["ENTRANCE", "EXIT"]),
  scanContext: z.enum(["fresh", "internal"]),
});

function denial(d: TypedDenial) {
  return json({ ok: false as const, denial: d });
}

export const POST = handler(
  { body: OpenGateBody },
  async ({ body, params }) => {
    const { driverId, deviceId, direction, scanContext } = body;
    const sessionId = (params as { id: string }).id;

    // Internal navigation — driver must re-scan the physical QR code
    if (scanContext === "internal") {
      return denial({
        code: DenialCode.RESCAN_REQUIRED,
        message: "Please re-scan the QR code at the gate.",
        severity: "info",
        recoverable: true,
      });
    }

    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { id: true, status: true, expectedEnd: true, driverId: true },
    });

    if (!session || session.driverId !== driverId) {
      await audit({
        action: "GATE_DENIED",
        sessionId: session?.id,
        driverId,
        details: `GATE_DENIED — SESSION_NOT_OWNED — direction:${direction}`,
      }).catch(() => {});
      return denial({
        code: DenialCode.SESSION_NOT_OWNED,
        message: "This session does not belong to your account.",
        severity: "critical",
        recoverable: false,
      });
    }

    if (!["ACTIVE", "OVERSTAY"].includes(session.status)) {
      await audit({
        action: "GATE_DENIED",
        sessionId,
        driverId,
        details: `GATE_DENIED — SESSION_NOT_ACTIVE — direction:${direction}`,
      }).catch(() => {});
      return denial({
        code: DenialCode.SESSION_NOT_ACTIVE,
        message: "No active session found.",
        severity: "warning",
        recoverable: false,
      });
    }

    const effectiveStatus =
      session.status === "OVERSTAY" ||
      (session.status === "ACTIVE" && session.expectedEnd < new Date())
        ? "OVERSTAY"
        : "ACTIVE";

    if (direction === "ENTRANCE" && effectiveStatus === "OVERSTAY") {
      await audit({
        action: "GATE_DENIED",
        sessionId,
        driverId,
        details: `GATE_DENIED — SESSION_OVERSTAY — direction:ENTRANCE`,
      }).catch(() => {});
      return denial({
        code: DenialCode.SESSION_OVERSTAY,
        message: "Your session has expired. Settle the overstay fee before re-entering.",
        severity: "warning",
        recoverable: true,
      });
    }

    const { suspicious } = await checkSuspiciousEntry(sessionId, driverId, deviceId, direction);
    if (suspicious) {
      return denial({
        code: DenialCode.SUSPICIOUS_ENTRY,
        message: "Entry blocked — this session was already scanned from a different device. Contact staff if this is an error.",
        severity: "critical",
        recoverable: false,
      });
    }

    const result = await triggerGateOpen();

    await audit({
      action: "GATE_OPEN",
      driverId,
      sessionId,
      details: [
        `Gate ${direction.toLowerCase()} via QR scan`,
        deviceId ? `device:${deviceId.slice(0, 8)}` : null,
      ].filter(Boolean).join(" — "),
    });

    return json({ ok: true as const, result: { openedAt: new Date().toISOString(), gateResponse: result } });
  },
);
