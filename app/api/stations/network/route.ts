import { getStationNetworkSummary } from "@/lib/station-service";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const lat = Number(searchParams.get("lat"));
  const lng = Number(searchParams.get("lng"));
  const radiusKm = Number(searchParams.get("radiusKm") || "250");
  const connectorType = searchParams.get("connectorType") || "CCS2";

  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return NextResponse.json({ error: "lat and lng query params are required" }, { status: 400 });
  }

  const summary = await getStationNetworkSummary({ lat, lng }, radiusKm, connectorType);
  return NextResponse.json(summary);
}
