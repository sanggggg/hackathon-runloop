import "server-only";
import { NextResponse } from "next/server";
import { ApiError } from "./api";

/** Route handlers may only export HTTP verbs, so shared helpers live here. */
export function toResponse(err: unknown) {
  const status = err instanceof ApiError ? err.status : 500;
  const message = err instanceof Error ? err.message : "Unexpected error";
  return NextResponse.json({ error: message }, { status });
}
