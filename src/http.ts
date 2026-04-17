export function ok(body: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ ...body, success: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export function err(status: number, message: string): Response {
  return new Response(JSON.stringify({ success: false, error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
