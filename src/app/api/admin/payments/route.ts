import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { handler, json } from "@/lib/api-handler";

const DEMO_ID_RE = /^demo_[a-z0-9-]+_\d{8}_\d{6}_[a-z0-9]{4}$/i;

const PaymentsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  type: z.enum(["CHECKIN", "MONTHLY_CHECKIN", "MONTHLY_RENEWAL", "EXTENSION", "OVERSTAY"]).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  q: z.string().optional(),
  demoId: z.string().trim().max(80).optional().transform((v) => (v && DEMO_ID_RE.test(v) ? v : undefined)),
});

export const GET = handler({ query: PaymentsQuery }, async ({ query }) => {
  await requireAdmin();

  const { limit, offset, type, from, to, q, demoId } = query;

  const where: Record<string, unknown> = {};
  if (type) where.type = type;
  if (from || to) {
    where.createdAt = {
      ...(from ? { gte: new Date(from) } : {}),
      ...(to ? { lte: new Date(to) } : {}),
    };
  }
  if (q) {
    where.OR = [
      { session: { driver: { name: { contains: q, mode: "insensitive" } } } },
      { session: { driver: { phone: { contains: q.replace(/\D/g, "") } } } },
      { session: { vehicle: { licensePlate: { contains: q, mode: "insensitive" } } } },
      { stripePaymentIntentId: { contains: q } },
      { stripeChargeId: { contains: q } },
      { stripeSubscriptionId: { contains: q } },
      { legacyQbReference: { contains: q } },
    ];
  }
  if (demoId) where.session = { driver: { email: { contains: demoId } } };

  const [payments, total, missingSalesReceipts, missingRefundReceipts, totals] = await Promise.all([
    prisma.payment.findMany({
      where,
      include: {
        session: {
          include: {
            driver: { select: { name: true, phone: true, qbCustomerId: true, stripeCustomerId: true } },
            vehicle: { select: { licensePlate: true, type: true } },
            spot: { select: { label: true } },
          },
        },
        refunds: { orderBy: { createdAt: "asc" } },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.payment.count({ where }),
    // Divergence: Stripe charges without QB Sales Receipt
    prisma.payment.count({
      where: {
        stripeChargeId: { not: null },
        qbSalesReceiptId: null,
        ...(demoId ? { session: { driver: { email: { contains: demoId } } } } : {}),
      },
    }),
    // Divergence: Stripe refunds without QB Refund Receipt
    prisma.paymentRefund.count({
      where: {
        qbRefundReceiptId: null,
        ...(demoId ? { payment: { session: { driver: { email: { contains: demoId } } } } } : {}),
      },
    }),
    // Aggregate totals by type — scoped to same demoId + date range as the list
    prisma.payment.groupBy({
      by: ["type"],
      where: {
        ...(from || to ? { createdAt: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } } : {}),
        ...(demoId ? { session: { driver: { email: { contains: demoId } } } } : {}),
      },
      _sum: { amount: true, refundedAmount: true },
      _count: true,
    }),
  ]);

  // Compute summary — net of refunds
  const summary = {
    totalRevenue: 0,
    checkinRevenue: 0,
    monthlyRevenue: 0,
    extensionRevenue: 0,
    overstayRevenue: 0,
    transactionCount: 0,
  };
  for (const t of totals) {
    const net = (t._sum.amount ?? 0) - (t._sum.refundedAmount ?? 0);
    summary.totalRevenue += net;
    summary.transactionCount += t._count;
    if (t.type === "CHECKIN") summary.checkinRevenue = net;
    if (t.type === "MONTHLY_CHECKIN") summary.monthlyRevenue = net;
    if (t.type === "EXTENSION") summary.extensionRevenue = net;
    if (t.type === "OVERSTAY") summary.overstayRevenue = net;
  }

  // Daily revenue for chart (last 30 days) — scoped to demoId when active
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
  const dailyRaw = await prisma.payment.groupBy({
    by: ["createdAt"],
    where: {
      createdAt: { gte: thirtyDaysAgo },
      ...(demoId ? { session: { driver: { email: { contains: demoId } } } } : {}),
    },
    _sum: { amount: true, refundedAmount: true },
  });

  // Aggregate by date string (the groupBy returns exact timestamps)
  const dailyMap: Record<string, number> = {};
  for (const row of dailyRaw) {
    const day = new Date(row.createdAt).toISOString().slice(0, 10);
    dailyMap[day] = (dailyMap[day] ?? 0) + (row._sum.amount ?? 0) - (row._sum.refundedAmount ?? 0);
  }

  // Fill in missing days with 0
  const dailyRevenue: { date: string; amount: number }[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    dailyRevenue.push({ date: d, amount: dailyMap[d] ?? 0 });
  }

  return json({
    payments,
    total,
    limit,
    offset,
    hasMore: offset + payments.length < total,
    summary,
    dailyRevenue,
    divergentCount: missingSalesReceipts + missingRefundReceipts,
  });
});
