import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  ReportAgentRow,
  ReportConversations,
  ReportOverview,
  ReportSummary,
  ReportTimeseries,
  ReportTimeseriesPoint,
} from '@chatflow/types';
import { PrismaService } from '../prisma/prisma.service';
import { ReportBucket, type ReportRangeQueryDto } from './dto/report-range-query.dto';

/** Hard ceiling on how much history one report may scan. */
const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000; // ~1 year
const DEFAULT_RANGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_ROWS = 500;
/** Upper bound on points in the volume-over-time series. */
const MAX_BUCKETS = 400;

const BUCKET_MS: Record<ReportBucket, number> = {
  [ReportBucket.HOUR]: 60 * 60 * 1000,
  [ReportBucket.DAY]: 24 * 60 * 60 * 1000,
  [ReportBucket.WEEK]: 7 * 24 * 60 * 60 * 1000,
};

/** Smallest bucket that keeps a series of `span` under MAX_BUCKETS. */
function widestBucketFor(span: number): ReportBucket {
  if (span / BUCKET_MS[ReportBucket.HOUR] + 2 <= MAX_BUCKETS) return ReportBucket.HOUR;
  if (span / BUCKET_MS[ReportBucket.DAY] + 2 <= MAX_BUCKETS) return ReportBucket.DAY;
  return ReportBucket.WEEK;
}

interface RawInterval {
  bucket: Date;
  conversations_created: bigint;
  conversations_closed: bigint;
  visitor_messages: bigint;
  agent_messages: bigint;
  ai_messages: bigint;
}

interface RawSummary {
  conversations_created: bigint;
  conversations_closed: bigint;
  open: bigint;
  pending: bigint;
  closed: bigint;
  ai_handled: bigint;
  handed_off: bigint;
  visitor_messages: bigint;
  agent_messages: bigint;
  ai_messages: bigint;
  avg_first_response_ms: number | null;
  avg_resolution_ms: number | null;
}

interface RawAgent {
  user_id: string;
  name: string;
  email: string;
  assigned: bigint;
  resolved: bigint;
  currently_open: bigint;
  reassigned_away: bigint;
  agent_messages: bigint;
  avg_first_response_ms: number | null;
}

interface RawConversation {
  id: string;
  created_at: Date;
  closed_at: Date | null;
  status: string;
  handling: string;
  subject: string | null;
  visitor_name: string | null;
  visitor_email: string | null;
  agent_name: string | null;
  first_response_ms: number | null;
  resolution_ms: number | null;
  message_count: bigint;
  ai_message_count: bigint;
}

/**
 * Reporting over the existing event/transaction tables.
 *
 * Design notes (the "which part is used for reporting" answer):
 *
 *  - `conversations` and `messages` both carry a denormalized `website_id`, so
 *    every aggregate here filters on a single indexed column and never joins
 *    across tenants.
 *  - All heavy lifting happens in Postgres (`$queryRaw`) rather than loading
 *    rows into Node. A month of traffic is aggregated by the database and only
 *    the small result set crosses the wire.
 *  - Every query is strictly parameterized through `Prisma.sql`, never string
 *    interpolation, so the date range and bucket can never become SQL syntax.
 *  - `bucket` is the one value that cannot be parameterized (Postgres accepts
 *    no bind parameter for `date_trunc`), so it is validated against a closed
 *    enum and only ever interpolated as that fixed literal — never user text.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Validates + clamps the requested window into a concrete, bounded range. */
  private resolveWindow(query: ReportRangeQueryDto): { from: Date; to: Date } {
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - DEFAULT_RANGE_MS);

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('from/to must be valid ISO 8601 date-times');
    }
    if (from > to) {
      throw new BadRequestException('from must be earlier than or equal to to');
    }
    if (to.getTime() - from.getTime() > MAX_RANGE_MS) {
      throw new BadRequestException('reporting range must not exceed 366 days');
    }
    return { from, to };
  }

  /** The validated window a request resolved to — echoed to clients. */
  window(query: ReportRangeQueryDto): { from: string; to: string } {
    const { from, to } = this.resolveWindow(query);
    return { from: from.toISOString(), to: to.toISOString() };
  }

  private bucketOf(query: ReportRangeQueryDto, from: Date, to: Date): ReportBucket {
    const span = to.getTime() - from.getTime();
    const sizeOf = (b: ReportBucket): number => BUCKET_MS[b];

    if (query.bucket) {
      // An explicit bucket is honoured only while the resulting series stays
      // small. `generate_series` has no limit of its own, so without this a
      // client asking for hourly buckets over a month would ask the database
      // for 2.5M rows.
      const points = Math.floor(span / sizeOf(query.bucket)) + 2;
      if (points > MAX_BUCKETS) {
        const widest = widestBucketFor(span);
        throw new BadRequestException(
          `bucket=${query.bucket} over this range would produce ${points} points ` +
            `(limit ${MAX_BUCKETS}); use bucket=${widest} or shorten the range`,
        );
      }
      return query.bucket;
    }

    // No explicit choice: pick a granularity that keeps the series readable.
    return widestBucketFor(span);
  }

  private limitOf(query: ReportRangeQueryDto): number {
    return Math.min(query.limit ?? 100, MAX_ROWS);
  }

  // ------------------------------------------------------------------ summary

  async summary(websiteId: string, query: ReportRangeQueryDto): Promise<ReportSummary> {
    const { from, to } = this.resolveWindow(query);

    const rows = await this.prisma.$queryRaw<RawSummary[]>(Prisma.sql`
      WITH scoped AS (
        SELECT
          c.id,
          c.status,
          c.handling,
          c.created_at,
          c.closed_at,
          EXISTS (
            SELECT 1 FROM messages m
            WHERE m.conversation_id = c.id AND m.sender_type = 'AI'
          ) AS ai_handled,
          c.handling <> 'AI' AS handed_off
        FROM conversations c
        WHERE c.website_id = ${websiteId}::uuid
          AND c.created_at >= ${from}
          AND c.created_at <= ${to}
      ),
      first_response AS (
        SELECT s.id, MIN(m.created_at) AS first_reply
        FROM scoped s
        JOIN messages m
          ON m.conversation_id = s.id
         AND m.sender_type = 'AGENT'
        GROUP BY s.id
      ),
      counted AS (
        SELECT s.*, fr.first_reply
        FROM scoped s
        LEFT JOIN first_response fr ON fr.id = s.id
      )
      SELECT
        COUNT(*)::bigint                                                          AS conversations_created,
        COUNT(*) FILTER (WHERE closed_at IS NOT NULL)::bigint                     AS conversations_closed,
        COUNT(*) FILTER (WHERE ai_handled)::bigint                                AS ai_handled,
        COUNT(*) FILTER (WHERE handed_off)::bigint                                AS handed_off,
        COALESCE(AVG(EXTRACT(EPOCH FROM (first_reply - created_at)) * 1000)
          FILTER (WHERE first_reply IS NOT NULL), 0)::double precision             AS avg_first_response_ms,
        COALESCE(AVG(EXTRACT(EPOCH FROM (closed_at - created_at)) * 1000)
          FILTER (WHERE closed_at IS NOT NULL), 0)::double precision               AS avg_resolution_ms
      FROM counted
    `);

    // Message volume and the current standing inventory are separate shapes
    // (messages are bounded by the window; open/pending/closed are "now"), so
    // they run as their own cheap aggregates.
    const [msgRow, standing] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{
          visitor_messages: bigint;
          agent_messages: bigint;
          ai_messages: bigint;
        }>
      >(Prisma.sql`
        SELECT
          COUNT(*) FILTER (WHERE sender_type = 'VISITOR')::bigint AS visitor_messages,
          COUNT(*) FILTER (WHERE sender_type = 'AGENT')::bigint   AS agent_messages,
          COUNT(*) FILTER (WHERE sender_type = 'AI')::bigint      AS ai_messages
        FROM messages
        WHERE conversation_id IN (
          SELECT id FROM conversations
          WHERE website_id = ${websiteId}::uuid
            AND created_at >= ${from} AND created_at <= ${to}
        )
      `),
      this.prisma.$queryRaw<Array<{ open: bigint; pending: bigint; closed: bigint }>>(
        Prisma.sql`
          SELECT
            COUNT(*) FILTER (WHERE status = 'OPEN')::bigint    AS open,
            COUNT(*) FILTER (WHERE status = 'PENDING')::bigint AS pending,
            COUNT(*) FILTER (WHERE status = 'CLOSED')::bigint  AS closed
          FROM conversations
          WHERE website_id = ${websiteId}::uuid
        `,
      ),
    ]);

    const created = Number(rows[0]?.conversations_created ?? 0n);
    const closedCount = Number(rows[0]?.conversations_closed ?? 0n);
    const aiHandled = Number(rows[0]?.ai_handled ?? 0n);
    const handedOff = Number(rows[0]?.handed_off ?? 0n);

    const ratio = (part: number): number =>
      created === 0 ? 0 : Number((part / created).toFixed(4));

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      conversationsCreated: created,
      conversationsClosed: closedCount,
      open: Number(standing[0]?.open ?? 0n),
      pending: Number(standing[0]?.pending ?? 0n),
      closed: Number(standing[0]?.closed ?? 0n),
      aiHandled,
      handedOff,
      visitorMessages: Number(msgRow[0]?.visitor_messages ?? 0n),
      agentMessages: Number(msgRow[0]?.agent_messages ?? 0n),
      aiMessages: Number(msgRow[0]?.ai_messages ?? 0n),
      avgFirstResponseMs: rows[0]?.avg_first_response_ms ?? null,
      avgResolutionMs: rows[0]?.avg_resolution_ms ?? null,
      aiHandlingRate: ratio(aiHandled),
      handoffRate: ratio(handedOff),
    };
  }

  // --------------------------------------------------------------- timeseries

  async timeseries(websiteId: string, query: ReportRangeQueryDto): Promise<ReportTimeseries> {
    const { from, to } = this.resolveWindow(query);
    const bucket = this.bucketOf(query, from, to);

    // Conversations and messages are each aggregated ONCE into a bucket map and
    // then joined onto the generated series. The earlier shape — a LATERAL
    // subquery per bucket — re-scanned the message table for every point.
    const rows = await this.prisma.$queryRaw<RawInterval[]>(Prisma.sql`
      WITH bounds AS (
        SELECT
          date_trunc(${bucket}::text, ${from}) AS lo,
          date_trunc(${bucket}::text, ${to})   AS hi,
          -- Series generation walks whole buckets, but the *data* filters must
          -- use the exact requested window: 'hi' is midnight, so using it as a
          -- message upper bound would silently drop everything from today.
          ${from} AS win_from,
          ${to}   AS win_to,
          -- An explicit CASE (not 'day_1'::interval, which Postgres parses as
          -- one *second*) keeps the step unambiguous. The bucket is a validated
          -- enum carried as a bind parameter, so this stays injection-safe.
          CASE ${bucket}::text
            WHEN 'hour' THEN interval '1 hour'
            WHEN 'day'  THEN interval '1 day'
            ELSE interval '1 week'
          END AS step
      ),
      buckets AS (
        SELECT generate_series(lo, hi, step) AS bucket
        FROM bounds
      ),
      conv AS (
        SELECT
          date_trunc(${bucket}::text, c.created_at) AS bucket,
          COUNT(*) FILTER (WHERE c.created_at >= ${from} AND c.created_at <= ${to}) AS created,
          COUNT(*) FILTER (WHERE c.closed_at  >= ${from} AND c.closed_at  <= ${to}) AS closed
        FROM conversations c
        WHERE c.website_id = ${websiteId}::uuid
        GROUP BY 1
      ),
      msgs AS (
        SELECT
          date_trunc(${bucket}::text, m.created_at) AS bucket,
          COUNT(*) FILTER (WHERE m.sender_type = 'VISITOR') AS visitor_messages,
          COUNT(*) FILTER (WHERE m.sender_type = 'AGENT')   AS agent_messages,
          COUNT(*) FILTER (WHERE m.sender_type = 'AI')      AS ai_messages
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        CROSS JOIN bounds b
        WHERE c.website_id = ${websiteId}::uuid
          AND m.created_at >= b.win_from
          AND m.created_at <= b.win_to
        GROUP BY 1
      )
      SELECT
        b.bucket,
        COALESCE(conv.created, 0)::bigint            AS conversations_created,
        COALESCE(conv.closed, 0)::bigint            AS conversations_closed,
        COALESCE(msgs.visitor_messages, 0)::bigint  AS visitor_messages,
        COALESCE(msgs.agent_messages, 0)::bigint    AS agent_messages,
        COALESCE(msgs.ai_messages, 0)::bigint       AS ai_messages
      FROM buckets b
      LEFT JOIN conv ON conv.bucket = b.bucket
      LEFT JOIN msgs ON msgs.bucket = b.bucket
      ORDER BY b.bucket ASC
    `);

    const points: ReportTimeseriesPoint[] = rows.map((row) => ({
      bucket: row.bucket.toISOString(),
      conversationsCreated: Number(row.conversations_created),
      conversationsClosed: Number(row.conversations_closed),
      visitorMessages: Number(row.visitor_messages),
      agentMessages: Number(row.agent_messages),
      aiMessages: Number(row.ai_messages),
    }));

    return { from: from.toISOString(), to: to.toISOString(), bucket, points };
  }

  // ------------------------------------------------------------------ agents

  async agents(websiteId: string, query: ReportRangeQueryDto): Promise<ReportAgentRow[]> {
    const { from, to } = this.resolveWindow(query);

    const rows = await this.prisma.$queryRaw<RawAgent[]>(Prisma.sql`
      WITH scoped AS (
        SELECT c.id, c.assigned_agent_id, c.status, c.closed_at, c.created_at
        FROM conversations c
        WHERE c.website_id = ${websiteId}::uuid
          AND c.created_at >= ${from}
          AND c.created_at <= ${to}
      ),
      -- Every assignment window that opened inside the window, with the
      -- conversation it belonged to, so "assigned" and "resolved" use the same
      -- population and an agent is credited for what they actually held.
      held AS (
        SELECT a.user_id, a.conversation_id, s.status, s.closed_at, s.created_at
        FROM conversation_assignments a
        JOIN scoped s ON s.id = a.conversation_id
        WHERE a.assigned_at >= ${from} AND a.assigned_at <= ${to}
      ),
      first_reply AS (
        SELECT m.conversation_id, MIN(m.created_at) AS first_reply
        FROM messages m
        WHERE m.sender_type = 'AGENT'
        GROUP BY m.conversation_id
      ),
      per_agent AS (
        SELECT
          h.user_id,
          COUNT(*)::bigint                                                          AS assigned,
          COUNT(*) FILTER (WHERE h.closed_at >= ${from} AND h.closed_at <= ${to})::bigint
            AS resolved,
          COUNT(*) FILTER (WHERE h.status <> 'CLOSED')::bigint                      AS currently_open,
          COALESCE(AVG(EXTRACT(EPOCH FROM (fr.first_reply - h.created_at)) * 1000)
            FILTER (WHERE fr.first_reply IS NOT NULL), 0)::double precision          AS avg_first_response_ms,
          COALESCE(SUM(m.agent_messages), 0)::bigint                                AS agent_messages
        FROM held h
        LEFT JOIN first_reply fr ON fr.conversation_id = h.conversation_id
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS agent_messages
          FROM messages m
          WHERE m.conversation_id = h.conversation_id AND m.sender_type = 'AGENT'
        ) m ON TRUE
        GROUP BY h.user_id
      ),
      churn AS (
        SELECT a.user_id, COUNT(*)::bigint AS reassigned_away
        FROM conversation_assignments a
        WHERE a.unassigned_at IS NOT NULL
          AND a.assigned_at >= ${from} AND a.assigned_at <= ${to}
        GROUP BY a.user_id
      ),
      spoke AS (
        SELECT a.user_id, COUNT(*)::bigint AS spoke
        FROM conversation_events e
        JOIN conversation_assignments a ON a.conversation_id = e.conversation_id
        WHERE e.type = 'CONVERSATION_REASSIGNED'
          AND a.user_id = e.actor_user_id
          AND e.created_at >= ${from} AND e.created_at <= ${to}
        GROUP BY a.user_id
      )
      SELECT
        u.id                        AS user_id,
        u.name                      AS name,
        u.email                     AS email,
        p.assigned                  AS assigned,
        p.resolved                  AS resolved,
        p.currently_open            AS currently_open,
        COALESCE(c.reassigned_away, 0)::bigint AS reassigned_away,
        p.agent_messages            AS agent_messages,
        p.avg_first_response_ms     AS avg_first_response_ms
      FROM per_agent p
      JOIN users u ON u.id = p.user_id
      LEFT JOIN churn c ON c.user_id = p.user_id
      LEFT JOIN spoke s ON s.user_id = p.user_id
      ORDER BY p.resolved DESC, p.assigned DESC, u.name ASC
      LIMIT ${this.limitOf(query)}
    `);

    return rows.map((row) => ({
      userId: row.user_id,
      name: row.name,
      email: row.email,
      assigned: Number(row.assigned),
      resolved: Number(row.resolved),
      currentlyOpen: Number(row.currently_open),
      reassignedAway: Number(row.reassigned_away),
      agentMessages: Number(row.agent_messages),
      avgFirstResponseMs: row.avg_first_response_ms || null,
    }));
  }

  // ----------------------------------------------------------- drill-down rows

  async conversations(websiteId: string, query: ReportRangeQueryDto): Promise<ReportConversations> {
    const { from, to } = this.resolveWindow(query);
    const limit = this.limitOf(query);

    const rows = await this.prisma.$queryRaw<RawConversation[]>(Prisma.sql`
      SELECT
        c.id,
        c.created_at,
        c.closed_at,
        c.status::text       AS status,
        c.handling::text     AS handling,
        c.subject,
        v.name               AS visitor_name,
        v.email              AS visitor_email,
        u.name               AS agent_name,
        EXTRACT(EPOCH FROM (fr.first_reply - c.created_at)) * 1000  AS first_response_ms,
        EXTRACT(EPOCH FROM (c.closed_at - c.created_at)) * 1000     AS resolution_ms,
        COALESCE(mc.message_count, 0)::bigint  AS message_count,
        COALESCE(mc.ai_count, 0)::bigint       AS ai_message_count
      FROM conversations c
      JOIN visitors v ON v.id = c.visitor_id
      LEFT JOIN users u ON u.id = c.assigned_agent_id
      LEFT JOIN LATERAL (
        SELECT MIN(msg.created_at) AS first_reply
        FROM messages msg
        WHERE msg.conversation_id = c.id AND msg.sender_type = 'AGENT'
      ) fr ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) AS message_count,
          COUNT(*) FILTER (WHERE msg.sender_type = 'AI') AS ai_count
        FROM messages msg
        WHERE msg.conversation_id = c.id
      ) mc ON TRUE
      WHERE c.website_id = ${websiteId}::uuid
        AND c.created_at >= ${from}
        AND c.created_at <= ${to}
      ORDER BY c.created_at DESC
      LIMIT ${limit}
    `);

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      total: rows.length,
      data: rows.map((row) => ({
        id: row.id,
        createdAt: row.created_at.toISOString(),
        closedAt: row.closed_at ? row.closed_at.toISOString() : null,
        status: row.status,
        handling: row.handling,
        subject: row.subject,
        visitorName: row.visitor_name,
        visitorEmail: row.visitor_email,
        assignedAgentName: row.agent_name,
        firstResponseMs: row.first_response_ms === null ? null : Number(row.first_response_ms),
        resolutionMs: row.resolution_ms === null ? null : Number(row.resolution_ms),
        messageCount: Number(row.message_count),
        aiMessageCount: Number(row.ai_message_count),
      })),
    };
  }

  /** One round trip for the whole Reports screen. */
  async overview(websiteId: string, query: ReportRangeQueryDto): Promise<ReportOverview> {
    const [summary, timeseries, agentRows] = await Promise.all([
      this.summary(websiteId, query),
      this.timeseries(websiteId, query),
      this.agents(websiteId, query),
    ]);
    return { summary, timeseries, agents: agentRows };
  }
}
