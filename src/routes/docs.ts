// GET /docs — static HTML that renders openapi.json via Scalar (loaded
// from a CDN). Zero runtime deps, pure client-side. The HTML points at
// /openapi.json (same-origin) so it works on any deployment without
// config.

const HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>share-it — API docs</title>
    <style>body { margin: 0; }</style>
  </head>
  <body>
    <script id="api-reference" data-url="/openapi.json"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>
`;

export function handleDocs(): Response {
  return new Response(HTML, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
