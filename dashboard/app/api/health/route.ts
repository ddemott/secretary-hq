import { NextResponse } from 'next/server';

const STARTED_AT = new Date().toISOString();

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    started_at: STARTED_AT,
  });
}
