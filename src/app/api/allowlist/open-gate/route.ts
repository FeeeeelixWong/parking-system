import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { triggerGateOpen } from "@/lib/gate";
import { log as audit } from "@/lib/audit";
import { handler, json } from "@/lib/api-handler";
import { DenialCode } from "@/types/actions";

const AllowListOpenGateBody = z.object({
  phone: z.string().min(4),
  deviceId: z.string().optional(),
  direction: z.enum(["ENTRANCE", "EXIT"]).optional(),
  scanContext: z.enum(["fresh", "internal"]),
});

export const POST = handler({ body: AllowListOpenGateBody }, async ({ body }) => {
  const { phone: rawPhone, deviceId, direction, scanContext } = body;

  if (scanContext !== "fresh") {
    return json({
      ok: false,
      denial: {
        code: DenialCode.RESCAN_REQUIRED,
        message: "Please re-scan the QR code at the gate.",
        severity: "info" as const,
        recoverable: true,
      },
    });
  }

  const phone = rawPhone.replace(/\D/g, "");

  const entry = await prisma.allowList.findUnique({ where: { phone } });
  if (!entry || !entry.active) {
    return json({
      ok: false,
      denial: {
        code: DenialCode.NOT_ON_ALLOWLIST,
        message: "Not on allow list",
        severity: "warning" as const,
        recoverable: false,
      },
    });
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

  return json({ ok: true, result: { ...result, openedAt: new Date().toISOString() } });
});
