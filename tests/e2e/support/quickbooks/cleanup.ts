/**
 * QB sandbox cleanup helpers — stubs pending real implementation.
 *
 * QB Online Sandbox does not support bulk delete. When we need real cleanup
 * we'll query by Customer.DisplayName prefix (e.g. "e2e-{testRunId}") and
 * mark each object Inactive (QB's soft-delete).
 *
 * Planned signatures:
 *   findTestCustomers(testRunId: string): Promise<{ id: string; name: string }[]>
 *   deleteTestCustomers(testRunId: string): Promise<void>
 */

export async function findTestCustomers(): Promise<{ id: string; name: string }[]> {
  throw new Error("[e2e/qb] findTestCustomers not yet implemented");
}

export async function deleteTestCustomers(): Promise<void> {
  throw new Error("[e2e/qb] deleteTestCustomers not yet implemented");
}
