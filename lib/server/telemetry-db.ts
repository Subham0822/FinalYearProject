import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

import type {
  AnalyticsSummary,
  RecommendationMode,
  RecommendationResponse,
  RouteFeedbackPayload,
  SelectionSource,
  TripRequest
} from "@/lib/types";

type SqlRow = Record<string, unknown>;

const storageDir = join(process.cwd(), ".voltpath");
const storageFile = join(storageDir, "telemetry.sqlite");

mkdirSync(storageDir, { recursive: true });

const db = new Database(storageFile);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS recommendations (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    mode TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    response_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS route_selections (
    id TEXT PRIMARY KEY,
    recommendation_id TEXT NOT NULL,
    route_id TEXT NOT NULL,
    route_label TEXT NOT NULL,
    selection_source TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS route_feedback (
    id TEXT PRIMARY KEY,
    recommendation_id TEXT NOT NULL,
    route_id TEXT NOT NULL,
    submitted_at TEXT NOT NULL,
    completed INTEGER NOT NULL,
    satisfaction_score INTEGER,
    actual_travel_minutes REAL,
    actual_charging_cost REAL,
    actual_wait_minutes REAL,
    actual_distance_km REAL,
    actual_charging_stops REAL,
    notes TEXT,
    UNIQUE(recommendation_id, route_id)
  );
`);

function randomId() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

function parseJson<T>(value: unknown) {
  return JSON.parse(String(value)) as T;
}

function getRoutes(response: RecommendationResponse) {
  return response.bestRoute ? [response.bestRoute, ...response.alternatives] : response.alternatives;
}

export function logRecommendation(payload: TripRequest, response: RecommendationResponse) {
  const recommendationId = randomId();

  db.prepare(`
    INSERT INTO recommendations (id, created_at, mode, payload_json, response_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    recommendationId,
    nowIso(),
    payload.mode,
    JSON.stringify(payload),
    JSON.stringify({ ...response, recommendationId })
  );

  return recommendationId;
}

export function logSelection({
  recommendationId,
  routeId,
  selectionSource
}: {
  recommendationId: string;
  routeId: string;
  selectionSource: SelectionSource;
}) {
  const recommendation = db
    .prepare("SELECT response_json FROM recommendations WHERE id = ?")
    .get(recommendationId) as SqlRow | undefined;

  if (!recommendation) {
    throw new Error("Recommendation not found");
  }

  const response = parseJson<RecommendationResponse>(recommendation.response_json);
  const route = getRoutes(response).find((entry) => entry.id === routeId);

  if (!route) {
    throw new Error("Recommendation route not found");
  }

  db.prepare(`
    INSERT INTO route_selections (id, recommendation_id, route_id, route_label, selection_source, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(randomId(), recommendationId, routeId, route.label, selectionSource, nowIso());
}

export function logFeedback(payload: RouteFeedbackPayload) {
  db.prepare(`
    INSERT INTO route_feedback (
      id, recommendation_id, route_id, submitted_at, completed, satisfaction_score,
      actual_travel_minutes, actual_charging_cost, actual_wait_minutes, actual_distance_km,
      actual_charging_stops, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(recommendation_id, route_id) DO UPDATE SET
      submitted_at = excluded.submitted_at,
      completed = excluded.completed,
      satisfaction_score = excluded.satisfaction_score,
      actual_travel_minutes = excluded.actual_travel_minutes,
      actual_charging_cost = excluded.actual_charging_cost,
      actual_wait_minutes = excluded.actual_wait_minutes,
      actual_distance_km = excluded.actual_distance_km,
      actual_charging_stops = excluded.actual_charging_stops,
      notes = excluded.notes
  `).run(
    randomId(),
    payload.recommendationId,
    payload.routeId,
    nowIso(),
    payload.completed ? 1 : 0,
    payload.satisfactionScore ?? null,
    payload.actualTravelMinutes ?? null,
    payload.actualChargingCost ?? null,
    payload.actualWaitMinutes ?? null,
    payload.actualDistanceKm ?? null,
    payload.actualChargingStops ?? null,
    payload.notes?.trim() || null
  );
}

export function getAnalyticsSummary(): AnalyticsSummary {
  const recommendationRows = db
    .prepare("SELECT id, mode, payload_json, response_json FROM recommendations ORDER BY created_at DESC")
    .all() as SqlRow[];
  const selectionRows = db
    .prepare("SELECT route_label, selection_source FROM route_selections ORDER BY created_at DESC")
    .all() as SqlRow[];
  const feedbackRows = db
    .prepare("SELECT * FROM route_feedback ORDER BY submitted_at DESC")
    .all() as SqlRow[];

  const routeChoiceBreakdown = Array.from(
    selectionRows.reduce((map, row) => {
      const label = String(row.route_label);
      map.set(label, (map.get(label) ?? 0) + 1);
      return map;
    }, new Map<string, number>())
  ).map(([routeLabel, selections]) => ({ routeLabel, selections }));

  const modeBreakdown = Array.from(
    recommendationRows.reduce((map, row) => {
      const mode = String(row.mode) as RecommendationMode;
      map.set(mode, (map.get(mode) ?? 0) + 1);
      return map;
    }, new Map<RecommendationMode, number>())
  ).map(([mode, count]) => ({ mode, count }));

  const routeLookup = new Map(
    recommendationRows.flatMap((row) => {
      const response = parseJson<RecommendationResponse>(row.response_json);
      return getRoutes(response).map((route) => [`${String(row.id)}:${route.id}`, route] as const);
    })
  );

  const recentOutcomes = feedbackRows.slice(0, 6).map((row) => {
    const route = routeLookup.get(`${String(row.recommendation_id)}:${String(row.route_id)}`);
    const recommendation = recommendationRows.find((entry) => String(entry.id) === String(row.recommendation_id));

    return {
      recommendationId: String(row.recommendation_id),
      routeId: String(row.route_id),
      routeLabel: route?.label ?? "Unknown route",
      submittedAt: String(row.submitted_at),
      completed: Number(row.completed) === 1,
      satisfactionScore: row.satisfaction_score == null ? null : Number(row.satisfaction_score),
      predictedTravelMinutes: route?.totalTravelMinutes ?? 0,
      actualTravelMinutes: row.actual_travel_minutes == null ? null : Number(row.actual_travel_minutes),
      predictedChargingCost: route?.totalChargingCost ?? 0,
      actualChargingCost: row.actual_charging_cost == null ? null : Number(row.actual_charging_cost),
      predictedWaitMinutes: route?.totalWaitMinutes ?? 0,
      actualWaitMinutes: row.actual_wait_minutes == null ? null : Number(row.actual_wait_minutes),
      mode: recommendation ? (String(recommendation.mode) as RecommendationMode) : "balanced",
      notes: row.notes == null ? null : String(row.notes)
    };
  });

  const travelPairs = recentOutcomes.filter((row) => row.actualTravelMinutes != null);
  const costPairs = recentOutcomes.filter((row) => row.actualChargingCost != null);
  const waitPairs = recentOutcomes.filter((row) => row.actualWaitMinutes != null);

  const feedbackCoverage =
    recommendationRows.length === 0 ? 0 : Number(((feedbackRows.length / recommendationRows.length) * 100).toFixed(1));

  return {
    totals: {
      recommendations: recommendationRows.length,
      selections: selectionRows.length,
      feedbackEntries: feedbackRows.length,
      retrainingSamples: feedbackRows.filter(
        (row) =>
          row.actual_travel_minutes != null || row.actual_charging_cost != null || row.actual_wait_minutes != null
      ).length,
      feedbackCoverage
    },
    routeChoiceBreakdown,
    modeBreakdown,
    predictionAccuracy: {
      travelMinutesMae:
        travelPairs.length === 0
          ? 0
          : Number(
              (
                travelPairs.reduce((sum, row) => sum + Math.abs((row.actualTravelMinutes ?? 0) - row.predictedTravelMinutes), 0) /
                travelPairs.length
              ).toFixed(1)
            ),
      chargingCostMae:
        costPairs.length === 0
          ? 0
          : Number(
              (
                costPairs.reduce((sum, row) => sum + Math.abs((row.actualChargingCost ?? 0) - row.predictedChargingCost), 0) /
                costPairs.length
              ).toFixed(1)
            ),
      waitMinutesMae:
        waitPairs.length === 0
          ? 0
          : Number(
              (
                waitPairs.reduce((sum, row) => sum + Math.abs((row.actualWaitMinutes ?? 0) - row.predictedWaitMinutes), 0) /
                waitPairs.length
              ).toFixed(1)
            )
    },
    recentOutcomes,
    trainingExportUrl: "/api/analytics/training-data"
  };
}

export function getTrainingDataset() {
  const recommendationRows = db
    .prepare("SELECT id, mode, payload_json, response_json FROM recommendations ORDER BY created_at DESC")
    .all() as SqlRow[];
  const feedbackRows = db
    .prepare("SELECT * FROM route_feedback ORDER BY submitted_at DESC")
    .all() as SqlRow[];

  return feedbackRows
    .map((row) => {
      const recommendation = recommendationRows.find((entry) => String(entry.id) === String(row.recommendation_id));

      if (!recommendation) {
        return null;
      }

      const payload = parseJson<TripRequest>(recommendation.payload_json);
      const response = parseJson<RecommendationResponse>(recommendation.response_json);
      const route = getRoutes(response).find((entry) => entry.id === String(row.route_id));

      if (!route) {
        return null;
      }

      return {
        recommendationId: String(recommendation.id),
        routeId: route.id,
        mode: recommendation.mode,
        origin: payload.origin,
        destination: payload.destination,
        vehicle: payload.vehicle,
        startingSoc: payload.startingSoc,
        reserveSoc: payload.reserveSoc,
        predictedTravelMinutes: route.totalTravelMinutes,
        predictedChargingCost: route.totalChargingCost,
        predictedWaitMinutes: route.totalWaitMinutes,
        actualTravelMinutes: row.actual_travel_minutes == null ? null : Number(row.actual_travel_minutes),
        actualChargingCost: row.actual_charging_cost == null ? null : Number(row.actual_charging_cost),
        actualWaitMinutes: row.actual_wait_minutes == null ? null : Number(row.actual_wait_minutes),
        completed: Number(row.completed) === 1,
        satisfactionScore: row.satisfaction_score == null ? null : Number(row.satisfaction_score),
        notes: row.notes == null ? null : String(row.notes)
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
}
