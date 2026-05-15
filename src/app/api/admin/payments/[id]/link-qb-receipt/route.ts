import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { handler, json, notFound, conflict } from "@/lib/api-handler";
import { getSalesReceipt } from "@/lib/quickbooks";
import { findNearbySalesReceiptMatches } from "@/lib/qb-nearby-matches";
import { log as audit } from "@/lib/audit";

const Body = z.object({
  qbSalesReceiptId: z.string().trim().min(1).max(64),
});

export const POST = handler({ body: Body }, async ({ params, body }) => {
  await requireAdmin();

  const id = params.id;
  if (!id) throw notFound("Payment not found");

  const payment = await prisma.payment.findUnique({
    where: { id },
    include: { session: { include: { driver: true } } },
  });
  if (!payment) throw notFound("Payment not found");
  if (!payment.stripeChargeId) {
    throw conflict("Cannot link a QB receipt before this payment has a Stripe charge ID");
  }
  if (payment.qbSalesReceiptId) {
    return json({
      ok: true,
      qbSalesReceiptId: payment.qbSalesReceiptId,
      alreadySynced: true,
    });
  }

  const existingLink = await prisma.payment.findFirst({
    where: { qbSalesReceiptId: body.qbSalesReceiptId, id: { not: id } },
    select: { id: true },
  });
  if (existingLink) {
    throw conflict(`QB Sales Receipt ${body.qbSalesReceiptId} is already linked to another payment`);
  }

  const receipt = await getSalesReceipt(body.qbSalesReceiptId);
  const matches = findNearbySalesReceiptMatches({
    paymentId: id,
    target: {
      amount: payment.amount,
      createdAt: payment.createdAt,
      driverName: payment.session.driver.name,
    },
    receipts: [receipt],
    linkedReceiptIds: new Set(),
    limit: 1,
  });
  const match = matches[0];
  if (!match) {
    throw conflict("Selected QB Sales Receipt is not close enough to this payment to link automatically");
  }

  await prisma.payment.update({
    where: { id },
    data: {
      qbSalesReceiptId: receipt.Id,
      qbSalesReceiptAmount: receipt.TotalAmt,
    },
  });

  await audit({
    action: "SALES_RECEIPT_WRITTEN",
    driverId: payment.session.driverId,
    sessionId: payment.sessionId,
    details: `Linked existing QB Sales Receipt ${receipt.DocNumber} (id ${receipt.Id}) to payment ${id} without creating a new QB receipt; match score ${match.score}`,
  });

  return json({
    ok: true,
    linkedExisting: true,
    qbSalesReceiptId: receipt.Id,
    qbSalesReceiptAmount: receipt.TotalAmt,
    match,
  });
});
