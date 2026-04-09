import { NextResponse } from "next/server";
import { getTrainingDataset } from "@/lib/server/telemetry-db";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      samples: getTrainingDataset()
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to export training dataset" },
      { status: 500 }
    );
  }
}
