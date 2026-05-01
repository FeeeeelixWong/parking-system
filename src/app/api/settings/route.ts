import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import { handler, json } from "@/lib/api-handler";
import { SettingsUpdateSchema } from "@/lib/schemas";
import { requireAdmin } from "@/lib/auth";

export const GET = handler({}, async () => {
  const settings = await getSettings();

  // Strip sensitive QB token fields — expose only connection status + expiry
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { qbAccessToken, qbRefreshToken: _qbRefreshToken, ...safe } = settings;
  const now = Date.now();
  const expiresMs = safe.qbTokenExpiresAt ? safe.qbTokenExpiresAt.getTime() : null;
  // Warn UI when token expires within 14 days (QB refresh tokens live ~100 days)
  const qbTokenExpiringSoon = expiresMs !== null && expiresMs - now < 14 * 24 * 60 * 60 * 1000;
  return json({
    settings: {
      ...safe,
      // Boolean flags for UI
      qbConnected: !!(qbAccessToken && safe.qbRealmId),
      qbTokenExpiringSoon,
      stripeConfigured: !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET),
      stripeTestMode: (process.env.STRIPE_SECRET_KEY ?? "").startsWith("sk_test_"),
    },
  });
});

export const PUT = handler(
  { body: SettingsUpdateSchema },
  async ({ body }) => {
    await requireAdmin();
    const settings = await prisma.settings.upsert({
      where: { id: "default" },
      update: body,
      create: { id: "default", ...body },
    });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { qbAccessToken, qbRefreshToken: _qbRefreshToken, ...safe } = settings;
    const now = Date.now();
    const expiresMs = safe.qbTokenExpiresAt ? safe.qbTokenExpiresAt.getTime() : null;
    const qbTokenExpiringSoon = expiresMs !== null && expiresMs - now < 14 * 24 * 60 * 60 * 1000;
    return json({
      settings: {
        ...safe,
        qbConnected: !!(qbAccessToken && safe.qbRealmId),
        qbTokenExpiringSoon,
      },
    });
  },
);
