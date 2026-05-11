-- Session: billing timestamps for failed-payment and delinquency events
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "billingFailedAt" TIMESTAMP(3);
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "billingDelinquentAt" TIMESTAMP(3);

-- Session: admin-initiated cancellation flag — prevents subscription.deleted from
-- marking the session DELINQUENT when the admin explicitly cancelled at period end
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "billingCancelledByAdmin" BOOLEAN NOT NULL DEFAULT false;

-- Settings: failed-payment access policy
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "failedPaymentPolicy" TEXT NOT NULL DEFAULT 'on_subscription_deleted';
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "failedPaymentGraceDays" INTEGER NOT NULL DEFAULT 7;
