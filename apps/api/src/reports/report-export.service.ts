import { BadRequestException, Injectable } from '@nestjs/common';
import type { ReportConversationRow } from '@chatflow/types';
import { ReportsService } from './reports.service';
import type { ReportRangeQueryDto } from './dto/report-range-query.dto';

const COLUMNS: Array<{ header: string; pick: (row: ReportConversationRow) => string }> = [
  { header: 'conversation_id', pick: (r) => r.id },
  { header: 'created_at', pick: (r) => r.createdAt },
  { header: 'closed_at', pick: (r) => r.closedAt ?? '' },
  { header: 'status', pick: (r) => r.status },
  { header: 'handling', pick: (r) => r.handling },
  { header: 'subject', pick: (r) => r.subject ?? '' },
  { header: 'visitor_name', pick: (r) => r.visitorName ?? '' },
  { header: 'visitor_email', pick: (r) => r.visitorEmail ?? '' },
  { header: 'assigned_agent', pick: (r) => r.assignedAgentName ?? '' },
  { header: 'first_response_seconds', pick: (r) => seconds(r.firstResponseMs) },
  { header: 'resolution_seconds', pick: (r) => seconds(r.resolutionMs) },
  { header: 'message_count', pick: (r) => String(r.messageCount) },
  { header: 'ai_message_count', pick: (r) => String(r.aiMessageCount) },
];

function seconds(ms: number | null): string {
  return ms === null ? '' : (ms / 1000).toFixed(1);
}

/**
 * RFC 4180 CSV serialization for the report drill-down.
 *
 * Anything that could contain a delimiter, quote or newline is quoted, and
 * embedded quotes are doubled. A leading `=`, `+`, `-` or `@` is additionally
 * prefixed with a single quote: spreadsheets otherwise treat the cell as a
 * formula, which turns a visitor-supplied subject line into a real injection
 * vector when an analyst opens the export.
 */
function escapeCell(value: string): string {
  const needsGuard = /^[=+\-@\t\r]/.test(value);
  const guarded = needsGuard ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

@Injectable()
export class ReportExportService {
  constructor(private readonly reports: ReportsService) {}

  async csv(websiteId: string, query: ReportRangeQueryDto): Promise<string> {
    // An export is meant to be the whole window, so it uses the largest row
    // budget rather than the interactive page size.
    const rows = await this.reports.conversations(websiteId, { ...query, limit: 500 });

    const lines = [COLUMNS.map((c) => c.header).join(',')];
    for (const row of rows.data) {
      lines.push(COLUMNS.map((c) => escapeCell(c.pick(row))).join(','));
    }
    return lines.join('\r\n');
  }

  /** `YYYY-MM-DD`-ish stamp used in the download filename. */
  filename(query: ReportRangeQueryDto): string {
    const to = query.to ? new Date(query.to) : new Date();
    if (Number.isNaN(to.getTime())) {
      throw new BadRequestException('to must be a valid ISO 8601 date-time');
    }
    return `chatflow-report-${to.toISOString().slice(0, 10)}.csv`;
  }
}
