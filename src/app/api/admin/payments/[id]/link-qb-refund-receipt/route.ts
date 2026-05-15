import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { handler, json, notFound, conflict } from "@/lib/api-handler";
import { getRefundReceipt } from "@/lib/quickbooks";
import { findNearbyRefundReceiptMatches } from "@/lib/qb-nearby-matches";
import { log as audit } from "@/lib/audit";

const Body = z.object({
  refundId: z.string().uuid(),
  qbRefundReceiptId: z.string().trim().min(1).max(64),
});

export const POST = handler({ body: Body }, async ({ params, body }) => {
  await requireAdmin();

  const id = params.id;
  if (!id) throw notFound("Payment not found");

  const payment = await prisma.payment.findUnique({
    where: { id },
    include: {
      session: { include: { driver: true } },
      refunds: true,
    },
  });
  if (!payment) throw notFound("Payment not found");

  const refund = payment.refunds.find((r) => r.id === body.refundId);
  if (!refund) throw notFound("Refund not found for this payment");
  if (!refund.stripeRefundId) {
    throw conflict("Cannot link a QB refund receipt before this refund has a Stripe refund ID");
  }
  if (refund.qbRefundReceiptId) {
    return json({
      ok: true,
      qbRefundReceiptId: refund.qbRefundReceiptId,
      alreadySynced: true,
    });
  }

  const existingLink = await prisma.paymentRefund.findFirst({
    where: { qbRefundReceiptId: body.qbRefundReceiptId, id: { not: refund.id } },
    select: { id: true },
  });
  if (existingLink) {
    throw conflict(`QB Refund Receipt ${body.qbRefundReceiptId} is already linked to another refund`);
  }

  const receipt = await getRefundReceipt(body.qbRefundReceiptId);
  const matches = findNearbyRefundReceiptMatches({
    paymentId: id,
    refundId: refund.id,
    target: {
      amount: refund.amount,
      createdAt: refund.createdAt,
      driverName: payment.session.driver.name,
    },
    refundReceipts: [receipt],
    linkedRefundReceiptIds: new Set(),
    limit: 1,
  });
  const match = matches[0];
  if (!match) {
    throw conflict("Selected QB Refund Receipt is not close enough to this refund to link automatically");
  }

  await prisma.paymentRefund.update({
    where: { id: refund.id },
    data: {
      qbRefundReceiptId: receipt.Id,
      qbRefundReceiptAmount: receipt.TotalAmt,
    },
  });

  await audit({
    action: "REFUND_ISSUED",
    driverId: payment.session.driverId,
    sessionId: payment.sessionId,
    details: `Linked existing QB Refund Receipt ${receipt.DocNumber} (id ${receipt.Id}) to refund ${refund.id} without creating a new QB refund receipt; match score ${match.score}`,
  });

  return json({
    ok: true,
    linkedExisting: true,
    qbRefundReceiptId: receipt.Id,
    qbRefundReceiptAmount: receipt.TotalAmt,
    match,
  });
});
