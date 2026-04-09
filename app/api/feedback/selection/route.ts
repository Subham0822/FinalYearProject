import { NextResponse } from "next/server";
import { logSelection } from "@/lib/server/telemetry-db";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as {
      recommendationId?: string;
      routeId?: string;
      selectionSource?: "recommended-default" | "user-manual";
    };

    if (!payload.recommendationId || !payload.routeId || !payload.selectionSource) {
      return NextResponse.json({ error: "Missing selection payload fields" }, { status: 400 });
    }

    logSelection({
      recommendationId: payload.recommendationId,
      routeId: payload.routeId,
      selectionSource: payload.selectionSource
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to log route selection" },
      { status: 500 }
    );
  }
}
