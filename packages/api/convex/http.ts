import { httpRouter } from "convex/server";

import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";

const http = httpRouter();

http.route({ pathPrefix: "/private-files/", method: "GET", handler: httpAction(async (ctx, request) => {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) return new Response(JSON.stringify({ code: "UNAUTHENTICATED" }), { status: 401, headers: { "content-type": "application/json" } });
  const fileId = new URL(request.url).pathname.slice("/private-files/".length);
  if (fileId.length === 0) return new Response(JSON.stringify({ code: "NOT_FOUND" }), { status: 404, headers: { "content-type": "application/json" } });
  try {
    const file = await ctx.runQuery(internal.files.authorizePrivateFileDownload, { ownerId: identity.subject, fileId: fileId as never });
    const blob = await ctx.storage.get(file.storageId);
    if (blob === null) return new Response(JSON.stringify({ code: "NOT_FOUND" }), { status: 404, headers: { "content-type": "application/json" } });
    return new Response(blob, { status: 200, headers: { "content-type": file.contentType, "cache-control": "private, no-store" } });
  } catch {
    return new Response(JSON.stringify({ code: "NOT_FOUND" }), { status: 404, headers: { "content-type": "application/json" } });
  }
}) });

export default http;
