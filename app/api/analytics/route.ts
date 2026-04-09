import { NextResponse } from "next/server";
import { getAnalyticsSummary } from "@/lib/server/telemetry-db";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json(getAnalyticsSummary());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load analytics" },
      { status: 500 }
    );
  }
}
