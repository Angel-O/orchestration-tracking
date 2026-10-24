import type { ReportMetadata, ReportMetadataRecord, ReportSnapshot } from "../tracking/models.js";

/** The reporting read capability used by snapshot-based consumers. */
export interface ReportSnapshotReader {
  readReportSnapshot(): ReportSnapshot;
}

/** The extra persistence capability required by report artifact generation. */
export interface ReportArtifactStore extends ReportSnapshotReader {
  readonly dataDir: string;
  recordReport(input: ReportMetadata): ReportMetadataRecord;
}
