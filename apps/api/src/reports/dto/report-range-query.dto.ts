import { Type } from 'class-transformer';
import { IsDateString, IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';

/** Granularity for the volume-over-time series. */
export enum ReportBucket {
  HOUR = 'hour',
  DAY = 'day',
  WEEK = 'week',
}

/**
 * Shared reporting window. Both bounds are inclusive and always required to be
 * a coherent pair: an unbounded report would silently scan the whole retention
 * window on every request, so the API enforces a maximum span (see
 * `resolveWindow`) rather than trusting the client to be reasonable.
 */
export class ReportRangeQueryDto {
  @IsOptional()
  @IsDateString({}, { message: 'from must be an ISO 8601 date-time' })
  from?: string;

  @IsOptional()
  @IsDateString({}, { message: 'to must be an ISO 8601 date-time' })
  to?: string;

  @IsOptional()
  @IsEnum(ReportBucket, { message: 'bucket must be one of hour, day, week' })
  bucket?: ReportBucket;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit must be an integer' })
  @Min(1)
  @Max(500, { message: 'limit must be at most 500' })
  limit?: number;
}
