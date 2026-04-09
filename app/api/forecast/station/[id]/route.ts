import { requestStationForecast } from "@/lib/python-service";
import { NextResponse } from "next/server";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { searchParams } = new URL(request.url);
  const { id } = await params;
  const departureTime = searchParams.get("departureTime") || new Date().toISOString();
  const offsetMinutes = Number(searchParams.get("offsetMinutes") || "0");

  const response = await requestStationForecast(id, departureTime, offsetMinutes);
  if (!response.forecast) {
    return NextResponse.json({ error: "Station not found" }, { status: 404 });
  }

  return NextResponse.json(response);
}
