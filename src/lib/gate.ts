import { prisma } from "./prisma";
import { log as audit } from "./audit";

export async function triggerGateOpen(): Promise<{ success: boolean }> {
  // Stub: replace with actual hardware integration (Shelly relay, etc.)
  console.log("[GATE] Opening gate...");
  return { success: true };
}

/**
 * Detect two consecutive ENTRANCE scans from different devices on the same
 * session (possible QR cloning). Returns { suspicious: true } and writes a
 * SUSPICIOUS_ENTRY audit log when detected. Fails-open on any DB error so
 * legitimate drivers are never incorrectly blocked by a detection failure.
 */
export async function checkSuspiciousEntry(
  sessionId: string,
  driverId: string,
  deviceId: string | undefined,
  direction: "ENTRANCE" | "EXIT",
): Promise<{ suspicious: boolean }> {
  if (direction !== "ENTRANCE" || !deviceId) return { suspicious: false };

  try {
    const recentGateEvents = await prisma.auditLog.findMany({
      where: {
        sessionId,
        action: "GATE_OPEN",
        details: { contains: "Gate entrance" },
      },
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
          driverId,
          details: `BLOCKED — double entrance from different devices: device:${currentDevicePrefix} after device:${prevDevicePrefix}`,
        });
        return { suspicious: true };
      }
    }
  } catch {
    // Fail-open: detection failure must never block a legitimate driver
  }

  return { suspicious: false };
}
