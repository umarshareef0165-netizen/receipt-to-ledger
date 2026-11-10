import { NextResponse } from "next/server";
import { isClockedConfigured } from "@/lib/clocked";

/** GET /api/status — tells the UI only whether a Clocked key is configured.
 *  The key itself is never returned, logged, or sent to the browser. */
export async function GET() {
  return NextResponse.json({ clockedConfigured: isClockedConfigured() });
}
