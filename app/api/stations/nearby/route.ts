import { requestNearbyStations } from "@/lib/python-service";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const lat = Number(searchParams.get("lat"));
  const lng = Number(searchParams.get("lng"));
  const radiusKm = Number(searchParams.get("radiusKm") || "300");

  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return NextResponse.json({ error: "lat and lng query params are required" }, { status: 400 });
  }

  const response = await requestNearbyStations(lat, lng, radiusKm);
  return NextResponse.json(response);
}
