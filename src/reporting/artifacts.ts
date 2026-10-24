import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildReportModels } from "./build.js";
import type { ReportArtifactStore } from "./contracts.js";
import { renderReport } from "./markdown.js";
import {
  REPORTING_POLICY_VERSION,
  type ReportGenerationResult,
  type ReportSelector,
} from "./models.js";

function stableReportID(selector: ReportSelector): string {
  const digest = createHash("sha256")
    .update(`${REPORTING_POLICY_VERSION}\n${JSON.stringify(selector)}`)
    .digest("hex")
    .slice(0, 32);
  return `report-${digest}`;
}

function writePrivateArtifact(reportDirectory: string, fileName: string, content: string): string {
  const artifactPath = join(reportDirectory, fileName);
  const temporaryPath = join(reportDirectory, `.${fileName}.${randomUUID()}.tmp`);
  writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, artifactPath);
  chmodSync(artifactPath, 0o600);
  return artifactPath;
}

/** Classify local facts and atomically replace one private JSON/Markdown artifact pair. */
export function generateReport(
  store: ReportArtifactStore,
  input: ReportSelector = {},
  generatedAt = Date.now(),
): ReportGenerationResult {
  const snapshot = store.readReportSnapshot();
  const { report, selector } = buildReportModels(snapshot, input, generatedAt);
  const reportID = stableReportID(selector);
  const artifactKey = `reports/${reportID}.json`;
  const renderedArtifactKey = `reports/${reportID}.md`;
  const reportDirectory = join(store.dataDir, "reports");
  mkdirSync(reportDirectory, { recursive: true, mode: 0o700 });
  chmodSync(reportDirectory, 0o700);
  const artifactPath = writePrivateArtifact(
    reportDirectory,
    `${reportID}.json`,
    `${JSON.stringify(report, null, 2)}\n`,
  );
  const renderedArtifactPath = writePrivateArtifact(
    reportDirectory,
    `${reportID}.md`,
    renderReport(report),
  );
  const sourceHighWaterMark = snapshot.sourceHighWaterMark;
  store.recordReport({
    reportID,
    artifactPath: artifactKey,
    selectorFingerprint: reportID.slice("report-".length),
    policyVersion: REPORTING_POLICY_VERSION,
    sourceHighWaterMark,
    generatedAt: report.generatedAt,
  });
  return {
    reportID,
    artifactPath,
    artifactKey,
    renderedArtifactPath,
    renderedArtifactKey,
    sourceHighWaterMark,
    report,
  };
}
