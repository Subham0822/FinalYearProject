import { NextResponse } from "next/server";
import { logFeedback } from "@/lib/server/telemetry-db";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as {
      recommendationId?: string;
      routeId?: string;
      completed?: boolean;
      satisfactionScore?: number | null;
      actualTravelMinutes?: number | null;
      actualChargingCost?: number | null;
      actualWaitMinutes?: number | null;
      actualDistanceKm?: number | null;
      actualChargingStops?: number | null;
      notes?: string | null;
    };

    if (!payload.recommendationId || !payload.routeId || typeof payload.completed !== "boolean") {
      return NextResponse.json({ error: "Missing feedback payload fields" }, { status: 400 });
    }

    logFeedback({
      recommendationId: payload.recommendationId,
      routeId: payload.routeId,
      completed: payload.completed,
      satisfactionScore: payload.satisfactionScore,
      actualTravelMinutes: payload.actualTravelMinutes,
      actualChargingCost: payload.actualChargingCost,
      actualWaitMinutes: payload.actualWaitMinutes,
      actualDistanceKm: payload.actualDistanceKm,
      actualChargingStops: payload.actualChargingStops,
      notes: payload.notes
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to store route feedback" },
      { status: 500 }
    );
  }
}
