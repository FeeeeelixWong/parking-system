## Scope

- 

## Verification

- [ ] `npm run lint`
- [ ] `npx tsc --noEmit`
- [ ] Relevant Playwright/API tests:
- [ ] If `prisma/schema.prisma` changed, a committed migration exists and `npx prisma migrate status` was checked.
- [ ] If Stripe/QB/admin external writes changed, landed/skipped/failed states are explicit and idempotent retry behavior was reviewed.
- [ ] If an E2E contract changed, `tests/e2e/TEST_CONTRACTS.md` was updated.

## Risk Notes

- Money state:
- Access state:
- Admin disposition / Needs Review:
- Demo/test isolation:
