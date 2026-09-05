// app router + TypeScript + @vercel/kv: GET reads the counter, POST increments it.
import { kv } from '@vercel/kv';
import { NextResponse, type NextRequest } from 'next/server';

export const runtime = 'edge';
const KEY: string = 'hits';

interface Body { by?: number }

export async function GET(request: NextRequest): Promise<Response> {
  const hits = (await kv.get<number>(KEY)) ?? 0;
  const label = request.nextUrl.searchParams.get('label') as string | null;
  return NextResponse.json({ hits, label: label ?? 'total' });
}

export async function POST(request: NextRequest) {
  let by: number = 1;
  try {
    const body = (await request.json()) as Body;
    if (typeof body.by === 'number') by = body.by;
  } catch (e: unknown) {
    by = 1;
  }
  const hits = await kv.incrby(KEY, by);
  return Response.json({ hits }, { status: 200 });
}
