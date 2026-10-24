import { expect, test } from "bun:test";
import { renderReportDetailHtml } from "../../src/reporting/html.js";
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
  const timelineStart = html.indexOf("<h3>Phase segments / Session–Shared timeline</h3>");
  const timeline = html.slice(timelineStart, html.indexOf("<h2>Passes</h2>", timelineStart));

  expect(html).toContain("Direct epic active time");
  expect(html).toContain("40 ms");
  expect(html).toContain("Summed child active time");
  expect(html).toContain("<h2>Timing</h2>");
  expect(html).toContain("Shared time scale:");
  expect(html).toContain(
    "P&lt;n&gt; labels are session-local action ordinals: they restart independently for each session and are not global workflow rounds.",
  );
  expect(html).not.toContain("metric-grid");
  expect(html).toMatch(
    /<h3>Phase segments \/ Session–Shared timeline<\/h3><div class="timeline-scroll"><table><thead><tr><th>Session<\/th><th>Active time<\/th><th>Shared timeline<\/th><\/tr>/u,
  );
  expect(timeline).toContain('<td>session&lt;&amp;</td><td>40 ms</td><td class="segments">');
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
  expect(passCell).toContain(
    'aria-label="Timeline for session&lt;&amp;, session-local action ordinal P7"',
  );
  expect(passCell).toContain("session&lt;&amp;; session-local action ordinal P7;");
  expect((passCell.match(/class="timeline-segment"/g) ?? []).length).toBe(2);
});

test("summarizes phases with distinct agent passes, union time, and shared-axis gaps", () => {
  const html = renderReportDetailHtml({
    ...detail,
    kind: "child",
    phases: [{ ...detail.phases[0]!, passCount: 3 }],
    passes: [
      ...detail.passes,
      {
        ...detail.passes[0]!,
        passNumber: 8,
        sessionID: "other",
        actionID: "second",
        agent: "worker<&",
        startedAt: 5,
        endedAt: 35,
        activeMs: 10,
        segments: [
          {
            sliceID: 3,
            startedAt: 5,
            endedAt: 10,
            activeMs: 5,
            startPercent: 12.5,
            endPercent: 25,
            widthPercent: 12.5,
          },
          {
            sliceID: 5,
            startedAt: 30,
            endedAt: 35,
            activeMs: 5,
            startPercent: 75,
            endPercent: 87.5,
            widthPercent: 12.5,
          },
        ],
      },
      {
        ...detail.passes[0]!,
        passNumber: 1,
        sessionID: "third",
        actionID: "third",
        agent: "reviewer",
        startedAt: 10,
        endedAt: 15,
        activeMs: 5,
        segments: [
          {
            sliceID: 4,
            startedAt: 10,
            endedAt: 15,
            activeMs: 5,
            startPercent: 25,
            endPercent: 37.5,
            widthPercent: 12.5,
          },
        ],
      },
    ],
  });
  const summaryStart = html.indexOf("<h3>Phase summary</h3>");
  const detailedStart = html.indexOf("<h3>Phase segments / Session–Shared timeline</h3>");
  const summary = html.slice(summaryStart, detailedStart);

  expect(summary).toContain(
    '<td><span class="swatch" style="background:#cfe8ff" aria-hidden="true"></span>Captured implementation &lt;&amp;</td><td>25 ms</td><td class="segments"><div class="muted">worker&lt;&amp; (2), reviewer (1)</div>',
  );
  expect(summary).toContain("worker&lt;&amp; (2), reviewer (1)");
  expect(summary).toContain("25 ms");
  expect(summary).toContain("left:0%;width:25%;");
  expect(summary).toContain("left:75%;width:25%;");
  expect((summary.match(/class="timeline-segment"/g) ?? []).length).toBe(5);
  expect(html.indexOf("<h3>Phase summary</h3>") < detailedStart).toBe(true);
  expect(html.slice(detailedStart).includes("<th>Session</th>")).toBe(true);
});

test("leaves active time unknown for incomplete timeline passes", () => {
  const html = renderReportDetailHtml({
    ...detail,
    passes: [{ ...detail.passes[0]!, outcome: "incomplete", endedAt: null, activeMs: 0 }],
  });
  const timelineStart = html.indexOf("<h3>Phase segments / Session–Shared timeline</h3>");
  const timeline = html.slice(timelineStart, html.indexOf("<h2>Passes</h2>", timelineStart));

  expect(timeline).toContain('<td>session&lt;&amp;</td><td>—</td><td class="segments">');
  expect(timeline).not.toContain("<td>0 ms</td>");
});

test("renders generated and finalized timestamps in local time", () => {
  const generatedAt = Date.parse("2025-06-15T12:34:56.789Z");
  const finalizedAt = Date.parse("2025-06-16T01:23:45.678Z");
  const html = renderReportDetailHtml({ ...detail, generatedAt, finalizedAt });

  expect(html).toContain(`<dt>Generated</dt><dd>${new Date(generatedAt).toLocaleString()}</dd>`);
  expect(html).toContain(`<dt>Finalized</dt><dd>${new Date(finalizedAt).toLocaleString()}</dd>`);
  expect(html).not.toContain(new Date(generatedAt).toISOString());
  expect(html).not.toContain(new Date(finalizedAt).toISOString());
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
