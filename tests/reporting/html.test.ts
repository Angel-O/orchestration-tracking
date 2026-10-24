import { expect, test } from "bun:test";
import { renderReportDetailHtml } from "../../src/index.js";
import type { ReportDetailModel } from "../../src/reporting/models.js";

const phaseTotals = {
  scoping: { activeMs: 0, actionCount: 0 },
  "scoping-decomposition": { activeMs: 0, actionCount: 0 },
  coordination: { activeMs: 0, actionCount: 0 },
  implementation: { activeMs: 40, actionCount: 1 },
  review: { activeMs: 0, actionCount: 0 },
  "integration-validation": { activeMs: 0, actionCount: 0 },
  build: { activeMs: 0, actionCount: 0 },
  unclassified: { activeMs: 0, actionCount: 0 },
} as const;

const child = {
  beadID: "child<&",
  type: "task",
  lifecycleState: "Closeout complete",
  metrics: {
    activeMs: 20,
    elapsedMs: 20,
    sessionCount: 1,
    actionCount: 1,
    outcomes: { open: 0, completed: 1, failed: 0, interrupted: 0, incomplete: 0 },
  },
  phaseTotals: {
    ...phaseTotals,
    implementation: { activeMs: 20, actionCount: 1 },
  },
} as const;

const detail: ReportDetailModel = {
  kind: "epic",
  beadID: 'epic<&"',
  status: "Active — closeout not observed",
  generatedAt: 2_000,
  finalizedAt: null,
  selection: { bead: 'epic<&"', sessions: ["session<&"], from: 0, to: 40 },
  metrics: {
    activeMs: 40,
    elapsedMs: 40,
    sessionCount: 1,
    actionCount: 1,
    outcomes: { open: 0, completed: 1, failed: 0, interrupted: 0, incomplete: 0 },
    directActiveMs: 40,
    summedChildActiveMs: 20,
    combinedActiveMs: 60,
    initiativeElapsedMs: 40,
  },
  phaseTotals,
  children: [child],
  projectLabel: "project<&",
  projectLabels: ["project<&"],
  durations: { activeMs: 40, elapsedMs: 40 },
  phases: [
    {
      phaseKey: "implementation",
      phaseLabel: "Captured implementation <&",
      color: "#cfe8ff",
      activeMs: 40,
      passCount: 1,
    },
  ],
  agents: [{ agent: "worker<&", activeMs: 40, passCount: 1 }],
  sessions: [
    {
      sessionID: "session<&",
      projectLabel: "project<&",
      activeMs: 40,
      passCount: 1,
      outcomes: { open: 0, completed: 1, failed: 0, interrupted: 0, incomplete: 0 },
    },
  ],
  passes: [
    {
      passNumber: 7,
      sessionID: "session<&",
      actionID: "action<&",
      agent: "worker<&",
      phaseKey: "implementation",
      phaseLabel: "Captured implementation <&",
      color: "#cfe8ff",
      outcome: "completed",
      startedAt: 0,
      endedAt: 40,
      activeMs: 40,
      segments: [
        {
          sliceID: 1,
          startedAt: 0,
          endedAt: 10,
          activeMs: 10,
          startPercent: 0,
          endPercent: 25,
          widthPercent: 25,
        },
        {
          sliceID: 2,
          startedAt: 30,
          endedAt: 40,
          activeMs: 10,
          startPercent: 75,
          endPercent: 100,
          widthPercent: 25,
        },
      ],
    },
  ],
  scale: { startAt: 0, endAt: 40, durationMs: 40 },
  repeats: [
    {
      sessionID: "session<&",
      agent: "worker<&",
      phaseLabel: "Captured implementation <&",
      passes: 2,
      repeated: true,
      passNumbers: [3, 7],
      count: 2,
      repeatCount: 1,
    },
  ],
  incomplete: false,
  unmapped: false,
  warnings: ["warning <&"],
};

test("renders report detail as escaped, self-contained HTML with truthful bars", () => {
  const html = renderReportDetailHtml(detail);
  const passCellStart = html.indexOf('class="pass-track"');
  const passCell = html.slice(passCellStart, html.indexOf("</td>", passCellStart));
  const directTotalsStart = html.indexOf("<h2>Direct phase totals</h2>");
  const directTotals = html.slice(directTotalsStart, html.indexOf("<h2>Child summary</h2>"));

  expect(html).toContain("Direct epic active time");
  expect(html).toContain("40 ms");
  expect(html).toContain("Summed child active time");
  expect(html).toContain("<h2>Timing</h2>");
  expect(html).toContain("Shared time scale:");
  expect(html).not.toContain("metric-grid");
  expect(html).toMatch(
    /<h3>Phase segments \/ Session–Shared timeline<\/h3><div class="timeline-scroll"><table><thead><tr><th>Session<\/th><th>Shared timeline<\/th><\/tr>/u,
  );
  expect(html).toContain("child&lt;&amp;");
  expect(html).toContain("Captured implementation &lt;&amp;");
  expect(html).toContain("implementation");
  expect(html).toContain("worker&lt;&amp;");
  expect(html).toContain("completed: 1");
  expect(html).toContain("Repeat signals");
  expect(html).toContain("pass numbers 3, 7");
  expect(html).toContain("#cfe8ff");
  expect(directTotals).toContain("<td>Implementation</td>");
  expect(directTotals).not.toContain("Captured implementation");
  expect(html).toContain("warning &lt;&amp;");
  expect(html).not.toContain("<script");
  expect(html).not.toContain("href=");
  expect(html).not.toContain("src=");
  expect(html).not.toContain("http://");
  expect(html).not.toContain("https://");
  expect(html).not.toContain("<epic");
  expect(passCell).toContain("left:0%;width:25%;");
  expect(passCell).toContain("left:75%;width:25%;");
  expect((passCell.match(/class="timeline-segment"/g) ?? []).length).toBe(2);
});

test("keeps non-epic detail focused on its selected child projection", () => {
  const html = renderReportDetailHtml({
    ...detail,
    kind: "child",
    beadID: "child-1",
    children: undefined,
  });

  expect(html).toContain("Scope</dt><dd>child");
  expect(html).toContain("Passes");
  expect(html).not.toContain("Direct epic active time");
  expect(html).not.toContain("Child summary");
});
