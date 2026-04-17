import { join } from "node:path";

const VERSION = "0.1.0";

export function handleRoot(): Response {
  return new Response(
    JSON.stringify({
      name: "share-it",
      version: VERSION,
      openapi: "/openapi.json",
      docs: "/docs",
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        Link: '</openapi.json>; rel="service-desc", </docs>; rel="alternate"; type="text/html"',
      },
    },
  );
}

export function handleOpenapi(): Response {
  const file = Bun.file(join(import.meta.dir, "..", "..", "openapi.json"));
  return new Response(file.stream(), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
    },
  });
}
