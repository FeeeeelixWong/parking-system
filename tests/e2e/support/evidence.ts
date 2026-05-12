import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TestInfo } from "@playwright/test";

type EvidenceSnapshot = Record<string, unknown>;

type EvidenceReport = {
  scenarioId: string;
  objective: string;
  expectedChanges: string[];
  actions: Array<{ label: string; data?: unknown }>;
  before: EvidenceSnapshot;
  after: EvidenceSnapshot;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function changedSections(before: EvidenceSnapshot, after: EvidenceSnapshot) {
  const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort();
  return keys.filter((key) => stableJson(before[key]) !== stableJson(after[key]));
}

export async function writeEvidenceReport(testInfo: TestInfo, report: EvidenceReport) {
  const outDir = path.join(testInfo.project.outputDir, "evidence");
  await mkdir(outDir, { recursive: true });
  const changed = changedSections(report.before, report.after);
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(report.scenarioId)} Evidence</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; color: #1f2933; }
    h1 { font-size: 24px; margin-bottom: 6px; }
    h2 { font-size: 16px; margin-top: 28px; border-bottom: 1px solid #d9e2ec; padding-bottom: 6px; }
    .meta { color: #52606d; margin-bottom: 24px; }
    .pill { display: inline-block; background: #e6f6ff; color: #035388; border: 1px solid #bae3ff; border-radius: 999px; padding: 2px 8px; font-size: 12px; margin-right: 6px; }
    li { margin: 6px 0; }
    pre { background: #f5f7fa; border: 1px solid #d9e2ec; border-radius: 6px; padding: 12px; overflow: auto; font-size: 12px; line-height: 1.45; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <h1>${escapeHtml(report.scenarioId)}</h1>
  <div class="meta">${escapeHtml(report.objective)}</div>

  <h2>Expected Changes</h2>
  <ul>${report.expectedChanges.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>

  <h2>Actions</h2>
  <ol>${report.actions.map((action) => `<li><strong>${escapeHtml(action.label)}</strong>${action.data === undefined ? "" : `<pre>${escapeHtml(stableJson(action.data))}</pre>`}</li>`).join("")}</ol>

  <h2>Changed Sections</h2>
  <div>${changed.length === 0 ? "<span class=\"pill\">none</span>" : changed.map((key) => `<span class="pill">${escapeHtml(key)}</span>`).join("")}</div>

  <h2>Raw Scoped DB Snapshot</h2>
  <div class="grid">
    <section>
      <h2>Before</h2>
      <pre>${escapeHtml(stableJson(report.before))}</pre>
    </section>
    <section>
      <h2>After</h2>
      <pre>${escapeHtml(stableJson(report.after))}</pre>
    </section>
  </div>
</body>
</html>
`;
  const filePath = path.join(outDir, `${report.scenarioId}.html`);
  await writeFile(filePath, html, "utf8");
  await testInfo.attach(`${report.scenarioId} evidence`, {
    path: filePath,
    contentType: "text/html",
  });
  return filePath;
}
