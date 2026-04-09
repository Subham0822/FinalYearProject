import { requestRecommendation } from "@/lib/python-service";
import { logRecommendation } from "@/lib/server/telemetry-db";
import type { TripRequest } from "@/lib/types";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as TripRequest;
    const recommendation = await requestRecommendation(payload);
    const recommendationId = logRecommendation(payload, recommendation);
    return NextResponse.json({ ...recommendation, recommendationId });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to recommend route" },
      { status: 500 }
    );
  }
}
