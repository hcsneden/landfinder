import type { ParcelInsight } from '@lastbestland/shared';
import { query, queryOne } from '../../shared/db';
import { env } from '../../shared/env';
import { generateBuildabilitySummary, type ParcelContext } from '../../shared/bedrock';
import { days } from '../../shared/parcelCache';
import { logger } from '../../shared/logger';
import { metrics, MetricUnit } from '../../shared/metrics';
import { getWaterRights } from './waterRights';
import { getRoadAccess } from './roadAccess';
import { getUtilities } from './utilities';
import { getEnvironmentalRisk } from './environmentalRisk';
import { getConservationEasements } from './conservationEasements';

const TTL_MS = days(7);

interface InsightRow {
  id: string;
  parcel_id: string;
  insight_type: 'summary';
  content: string;
  model_version: string;
  created_at: string;
}

interface ParcelFacts {
  county: string | null;
  acreage: number | null;
  address: string | null;
}

const toInsight = (row: InsightRow): ParcelInsight => ({
  id: row.id,
  parcelId: row.parcel_id,
  insightType: row.insight_type,
  content: row.content,
  modelVersion: row.model_version,
  createdAt: row.created_at,
});

async function buildContext(parcelId: string, facts: ParcelFacts): Promise<ParcelContext> {
  const [waterRights, road, utilities, risk, easements] = await Promise.all([
    getWaterRights(parcelId),
    getRoadAccess(parcelId, false),
    getUtilities(parcelId, false),
    getEnvironmentalRisk(parcelId, false),
    getConservationEasements(parcelId, false),
  ]);
  return {
    ...facts,
    waterRights: waterRights.map((right) => ({
      waterSource: right.waterSource,
      waterType: right.waterType,
      flowRateGpm: right.flowRateGpm,
      volumeAcreFeet: right.volumeAcreFeet,
      priorityDate: right.priorityDate,
      status: right.status,
    })),
    roadAccess: road && {
      hasPublicAccess: road.hasPublicAccess,
      roadTypes: [...new Set(road.segments.map((segment) => segment.type))],
    },
    electric: utilities && {
      hasServiceTerritory: utilities.electric.serviceTerritory !== null,
      utilityName: utilities.electric.serviceTerritory?.utilityName ?? null,
      hasNearbyLine: utilities.electric.hasNearbyLine,
    },
    floodZones: risk?.floodZones ?? [],
    wildfireRisk: risk?.wildfireRisk ?? null,
    mineSiteCount: risk?.mineSites.length ?? 0,
    conservationEasements: (easements?.easements ?? []).map((easement) => ({
      holderName: easement.holderName,
      restrictions: easement.restrictions,
    })),
  };
}

async function generateSummary(parcelId: string, facts: ParcelFacts): Promise<ParcelInsight | null> {
  const start = Date.now();
  const content = await generateBuildabilitySummary(await buildContext(parcelId, facts));
  metrics.addMetric('InsightGenerated', MetricUnit.Count, 1);
  metrics.addMetric('BedrockCallLatency', MetricUnit.Milliseconds, Date.now() - start);

  const rows = await query<InsightRow>(
    `INSERT INTO parcel_insights (parcel_id, insight_type, content, model_version)
     VALUES ($1::uuid, 'summary', $2, $3)
     RETURNING id, parcel_id, insight_type, content, model_version, created_at`,
    [parcelId, content, env.bedrockModelId]
  );
  return rows[0] ? toInsight(rows[0]) : null;
}

/**
 * Returns the parcel's insights, newest first, generating a fresh buildability
 * summary when the latest one is older than the TTL. Generation failures are
 * logged and the existing insights are returned.
 */
export async function getInsights(parcelId: string): Promise<ParcelInsight[]> {
  const rows = await query<InsightRow>(
    `SELECT id, parcel_id, insight_type, content, model_version, created_at
     FROM parcel_insights WHERE parcel_id = $1::uuid ORDER BY created_at DESC`,
    [parcelId]
  );
  const insights = rows.map(toInsight);
  const latest = insights.find((insight) => insight.insightType === 'summary');
  const ageMs = latest ? Date.now() - new Date(latest.createdAt).getTime() : Infinity;
  if (ageMs <= TTL_MS) {
    metrics.addMetric('InsightCacheHit', MetricUnit.Count, 1);
    return insights;
  }

  const facts = await queryOne<ParcelFacts>('SELECT county, acreage, address FROM parcels WHERE id = $1::uuid', [parcelId]);
  if (!facts) return insights;
  try {
    const fresh = await generateSummary(parcelId, facts);
    return fresh ? [fresh, ...insights] : insights;
  } catch (err) {
    logger.warn('Insight generation failed', { parcelId, error: String(err) });
    return insights;
  }
}
