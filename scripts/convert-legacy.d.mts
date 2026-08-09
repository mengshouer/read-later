export interface LegacyConvertReport {
  lines: number;
  converted: number;
  unparseable: number;
  missingUrl: number;
  notHttp: number;
  duplicateUrls: number;
  derivedTitles: number;
  invalidTimestamps: number;
  scrollCarried: number;
  dropped: Array<{ reason: string; line: string }>;
}

export interface LegacyConvertedItem {
  url: string;
  title: string;
  addedAt: number;
  updatedAt: number;
  status: 'unread';
  progress: {
    scrollY: number;
    docHeight: number;
    percent: number;
    /** Always '' — the legacy format has no anchor text, so nothing can be restored. */
    textStart: string;
  } | null;
}

export interface LegacyConvertResult {
  payload: {
    format: 'read-later';
    schemaVersion: number;
    exportedAt: string;
    /** No `urlKey`: the importer derives it from `url` with the rules in force. */
    items: LegacyConvertedItem[];
  };
  report: LegacyConvertReport;
}

export function convertLegacyExport(text: string, options?: { now?: number }): LegacyConvertResult;
