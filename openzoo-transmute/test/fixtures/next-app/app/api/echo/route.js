// app router: POST echoes the JSON body with a 201 and a custom header; GET is plain text.
export async function POST(request) {
  const body = await request.json();
  const keys = Object.keys(body);
  const { searchParams } = new URL(request.url);
  const upper = searchParams.get('upper') === '1' ? JSON.stringify(body).toUpperCase() : null;
  return Response.json(
    { echo: body, keys, upper, ua: request.headers.get('user-agent') },
    { status: 201, headers: { 'x-echo-count': String(keys.length) } },
  );
}

export function GET() {
  return new Response('POST a JSON body to this route', { status: 200, headers: { 'content-type': 'text/plain' } });
}
