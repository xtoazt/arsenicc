/**
 * Arsenic — Cloudflare Worker (Static Assets + Bare Server + GAMP Font-Bomb)
 *
 * Architecture:
 *   1. Static files are served from the [assets] binding (public/).
 *   2. /bare/*  →  Minimal Bare v2 server (HTTP + WebSocket) implemented in-worker.
 *   3. All HTML responses are wrapped with a valid TrueType font header and served
 *      as application/octet-stream so Google AMP caches them.
 *   4. URL rewriting ensures assets load from the worker domain regardless of
 *      whether the page is accessed directly or through the AMP cache.
 *
 * Deploy:
 *   npm install
 *   npx wrangler login
 *   npx wrangler deploy
 *
 * Access via GAMP (Google AMP cache):
 *   https://<subdomain-dashes>.cdn.ampproject.org/r/s/<worker-domain>/<path>
 *
 *   Example (worker = arsenic.smartfoloo.workers.dev):
 *   https://arsenic--smartfoloo--workers-dev.cdn.ampproject.org/r/s/arsenic.smartfoloo.workers.dev/
 */

// ---------------------------------------------------------------------------
//  Font header (TrueType / OpenType)
// ---------------------------------------------------------------------------
const FONT_HEX =
  "00010000000a0080000300204f532f3269f96f2b0000013400000056636d" +
  "6170000b00730000018c00000034676c796600000000000000ac00000001" +
  "6865616427594c4f000000d400000036686865610d9f076e000001100000" +
  "0024686d7478028b00000000010c000000046c6f636100000000000000d0" +
  "000000046d617870004103c1000000b0000000206e616d65000600000000" +
  "01c000000006706f7374ffdb005a000001c8000000200000000000010000" +
  "00010354002b0068000c0001000000000000000000000000000800040000" +
  "00000001000000025eb8624511a85f0f3cf5001f080000000000e0fad139" +
  "00000000e0fad139f7d6fc4c0e5909dc000000080002000000000000028b" +
  "000000010000076dfe1d00000efef7d6fa510e5900010000000000000000" +
  "00000000000000010001040e019000050000053305990000011e05330599" +
  "000003d7006602120000020b060303080402020400000001000000000000" +
  "000000000000506645640040002000200614fe14019a076d01e300000001" +
  "000000000000000000020000000300000014000300010000001400040020" +
  "000000040004000100000020ffff00000020ffffffe00001000000000000" +
  "0000000600000003000000000000ffd8005a000000000000000000000000" +
  "0000000000000000";

function hexToBytes(hex) {
  const clean = hex.replace(/\s/g, "");
  const len = clean.length / 2;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

const FONT_BYTES = hexToBytes(FONT_HEX);
const BARE_PATH = "/bare/";
const BARE_VERSION = "v2";

// ---------------------------------------------------------------------------
//  Sitemap pages (mirrors src/index.js)
// ---------------------------------------------------------------------------
const SITE_PAGES = [
  { url: "/", lastmod: "2024-01-01", priority: "1.0" },
];

function generateSitemap(origin) {
  const urls = SITE_PAGES.map(
    (p) => `    <url>
      <loc>${origin}${p.url}</loc>
      <lastmod>${p.lastmod}</lastmod>
      <priority>${p.priority}</priority>
    </url>`
  ).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;
}

// ---------------------------------------------------------------------------
//  AMP-optimized response headers
// ---------------------------------------------------------------------------
const AMP_HTML_HEADERS = {
  "Content-Type": "application/octet-stream",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Requested-With, X-Bare-URL, X-Bare-Headers, X-Bare-Forward-Headers, X-Bare-Version",
  "Access-Control-Expose-Headers":
    "Content-Length, Content-Type, X-Bare-Status, X-Bare-Status-Text, X-Bare-Headers",
  "Cache-Control": "public, max-age=180, stale-while-revalidate=300",
  Vary: "Accept",
};

const AMP_NON_HTML_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Requested-With, X-Bare-URL, X-Bare-Headers, X-Bare-Forward-Headers",
  "Access-Control-Expose-Headers": "Content-Length, Content-Type",
};

const CORS_PREFLIGHT_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Requested-With, X-Bare-URL, X-Bare-Headers, X-Bare-Forward-Headers",
  "Access-Control-Max-Age": "86400",
};

// ---------------------------------------------------------------------------
//  URL rewriter — comprehensive attribute coverage
// ---------------------------------------------------------------------------
function rewriteHtml(html, workerOrigin) {
  let out = html;

  // --- 1. Specific relative-path prefixes (e.g. href="uv/...") ----------
  const relativePrefixes = [
    { attr: "href", prefix: "uv/" },
    { attr: "src", prefix: "uv/" },
    { attr: "href", prefix: "dynamic/" },
    { attr: "src", prefix: "dynamic/" },
    { attr: "href", prefix: "js/" },
    { attr: "src", prefix: "js/" },
    { attr: "href", prefix: "css/" },
    { attr: "src", prefix: "css/" },
    { attr: "href", prefix: "assets/" },
    { attr: "src", prefix: "assets/" },
    { attr: "href", prefix: "games/" },
    { attr: "src", prefix: "games/" },
    { attr: "href", prefix: "aero/" },
    { attr: "src", prefix: "aero/" },
  ];

  for (const { attr, prefix } of relativePrefixes) {
    const re = new RegExp(`${attr}="${prefix}`, "g");
    out = out.replace(re, `${attr}="${workerOrigin}/${prefix}`);
  }

  // --- 2. dot-relative (./) ---------------------------------------------
  out = out.replace(/href="\.\//g, `href="${workerOrigin}/`);
  out = out.replace(/src="\.\//g, `src="${workerOrigin}/`);

  // --- 3. Root-relative catch-all ---------------------------------------
  // href="/"  →  href="WORKER/"
  out = out.replace(/href="\/"/g, `href="${workerOrigin}/"`);
  out = out.replace(/src="\/"/g, `src="${workerOrigin}/"`);

  // href="/x…"  →  href="WORKER/x…"   (x is not another slash or quote)
  const hrefRootRe = new RegExp(`href="\\/([^"\\/])`, "g");
  out = out.replace(hrefRootRe, `href="${workerOrigin}/$1`);

  const srcRootRe = new RegExp(`src="\\/([^"\\/])`, "g");
  out = out.replace(srcRootRe, `src="${workerOrigin}/$1`);

  // --- 4. Other common URL-bearing attributes --------------------------
  const otherAttrs = [
    "action", "formaction", "poster", "cite", "longdesc",
    "data-src", "data-href", "data-url", "data-bg",
  ];
  for (const attr of otherAttrs) {
    const re1 = new RegExp(`${attr}="\\/"`, "g");
    out = out.replace(re1, `${attr}="${workerOrigin}/"`);

    const re2 = new RegExp(`${attr}="\\/([^"\\/])`, "g");
    out = out.replace(re2, `${attr}="${workerOrigin}/$1`);
  }

  // --- 5. srcset (space-separated list of url + descriptor pairs) ------
  out = out.replace(
    /srcset="\/"/g,
    `srcset="${workerOrigin}/"`
  );
  out = out.replace(
    /srcset="\/([^"\\/])/g,
    `srcset="${workerOrigin}/$1`
  );

  // --- 6. <meta> tags with content URLs --------------------------------
  out = out.replace(
    /<meta([^>]*)content="\/([^"]*?)"/gi,
    `<meta$1content="${workerOrigin}/$2"`
  );

  // --- 7. <link> tags (canonical, icon, apple-touch-icon, stylesheet) ----
  const linkRels = [
    { rel: "canonical", attr: "href" },
    { rel: "icon", attr: "href" },
    { rel: "shortcut icon", attr: "href" },
    { rel: "apple-touch-icon", attr: "href" },
    { rel: "stylesheet", attr: "href" },
  ];
  for (const { rel, attr } of linkRels) {
    const re = new RegExp(
      `<link([^>]*)rel="${rel}"([^>]*)${attr}="\\/([^"]*?)"`,
      "gi"
    );
    out = out.replace(re, `<link$1rel="${rel}"$2${attr}="${workerOrigin}/$3"`);
  }

  // --- 8. inline style="background-image:url(/…)" ---------------------
  out = out.replace(
    /url\("?\/([^")\s]*?)"?\)/g,
    `url("${workerOrigin}/$1")`
  );

  // --- 9. Remove manifest & service-worker registration ----------------
  out = out.replace(/<link rel="manifest"[^>]*>/gi, "");
  out = out.replace(/<link rel="serviceworker"[^>]*>/gi, "");

  // --- 10. JSON-LD / structured data with relative URLs ---------------
  out = out.replace(
    /"url"\s*:\s*"\/([^"]*?)"/g,
    `"url":"${workerOrigin}/$1"`
  );

  // --- 10a. Replace hardcoded old origin URLs ---------------------------
  out = out.replace(/https:\/\/arsenic\.smartfoloo\.space/g, workerOrigin);
  out = out.replace(/https:\/\/docs\.arsenic\.smartfoloo\.space/g, `${workerOrigin}/docs`);

  // --- 11. Inject worker origin for GAMP proxy support -----------------
  const originScript = `<script data-arsenic-origin>window.__ARSENIC_ORIGIN__=${JSON.stringify(workerOrigin)};</script>`;
  if (/<head\b[^>]*>/i.test(out)) {
    out = out.replace(/<head\b[^>]*>/i, match => match + originScript);
  } else if (/<html\b[^>]*>/i.test(out)) {
    out = out.replace(/<html\b[^>]*>/i, match => match + originScript);
  } else {
    out = originScript + out;
  }

  // --- 12. Navigation-helper script (fallback for dynamic URLs) ---------
  const navScript = `
<script data-amp-nav>
(function(){
  const WO=${JSON.stringify(workerOrigin)};
  function fix(u){ try{ var p=new URL(u,WO); if(p.origin!==WO && p.origin!==location.origin && !u.match(/^https?:\/\//i)) return WO+u; }catch(e){} return u; }
  document.addEventListener('click',function(e){
    var a=e.target.closest('a');
    if(a && a.href && !a.target && !a.download){
      var u=fix(a.getAttribute('href'));
      if(u && u!==a.href){ a.href=u; }
    }
  });
  document.addEventListener('submit',function(e){
    var f=e.target;
    if(f.action && f.action.indexOf(WO)!==0){
      var a=fix(f.getAttribute('action'));
      if(a) f.action=a;
    }
  });
})();
</script>`;

  if (out.includes("</head>")) {
    out = out.replace("</head>", navScript + "\n</head>");
  } else if (out.includes("</body>")) {
    out = out.replace("</body>", navScript + "\n</body>");
  } else {
    out += navScript;
  }

  return out;
}

// ---------------------------------------------------------------------------
//  Wrap raw bytes with the font header
// ---------------------------------------------------------------------------
function fontBomb(bodyBytes) {
  const out = new Uint8Array(FONT_BYTES.length + bodyBytes.length);
  out.set(FONT_BYTES, 0);
  out.set(bodyBytes, FONT_BYTES.length);
  return out;
}

// ---------------------------------------------------------------------------
//  GAMP path normalisation
//  Input:  https://sub--dom.cdn.ampproject.org/r/s/worker.workers.dev/foo
//  Path:   /r/s/worker.workers.dev/foo  →  /foo
//  Worker: worker.workers.dev
// ---------------------------------------------------------------------------
function normalizeGamp(url) {
  const gampMatch = url.pathname.match(/^\/r\/s\/([^/]+)(\/.*)?$/);
  if (gampMatch) {
    const workerDomain = gampMatch[1];
    const assetPath = gampMatch[2] || "/";
    return {
      isGamp: true,
      workerDomain,
      workerOrigin: `https://${workerDomain}`,
      assetPath,
    };
  }
  return {
    isGamp: false,
    workerDomain: url.host,
    workerOrigin: url.origin,
    assetPath: url.pathname,
  };
}

// ---------------------------------------------------------------------------
//  Bare v2 server (HTTP)
// ---------------------------------------------------------------------------
async function handleBare(request) {
  // --- CORS preflight --------------------------------------------------
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS });
  }

  // WebSocket upgrade
  if (request.headers.get("Upgrade") === "websocket") {
    return handleBareWebSocket(request);
  }

  const bareUrl = request.headers.get("X-Bare-URL");
  if (!bareUrl) {
    return new Response(
      JSON.stringify({ message: "Missing X-Bare-URL header" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // Parse X-Bare-Headers
  const bareHeadersJson = request.headers.get("X-Bare-Headers") || "{}";
  let bareHeaders;
  try {
    bareHeaders = JSON.parse(bareHeadersJson);
  } catch {
    return new Response(
      JSON.stringify({ message: "Invalid X-Bare-Headers JSON" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // Build request headers
  const fetchHeaders = new Headers();
  for (const [key, value] of Object.entries(bareHeaders)) {
    if (Array.isArray(value)) {
      for (const v of value) fetchHeaders.append(key, v);
    } else {
      fetchHeaders.set(key, value);
    }
  }

  // Forward selected headers from original request
  const forwardHeadersJson = request.headers.get("X-Bare-Forward-Headers");
  if (forwardHeadersJson) {
    try {
      const forwardHeaders = JSON.parse(forwardHeadersJson);
      for (const header of forwardHeaders) {
        const val = request.headers.get(header);
        if (val !== null) fetchHeaders.set(header, val);
      }
    } catch { /* ignore malformed forward headers */ }
  }

  // Make the proxied request
  let response;
  try {
    response = await fetch(bareUrl, {
      method: request.method,
      headers: fetchHeaders,
      body: request.body,
      redirect: "manual",
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ message: err.message }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }

  // Build bare response headers
  const respHeaders = new Headers();
  respHeaders.set("X-Bare-Status", String(response.status));
  respHeaders.set("X-Bare-Status-Text", response.statusText);

  const responseHeaders = {};
  for (const [key, value] of response.headers) {
    responseHeaders[key] = value;
  }
  respHeaders.set("X-Bare-Headers", JSON.stringify(responseHeaders));
  respHeaders.set("X-Bare-Version", BARE_VERSION);
  respHeaders.set("Access-Control-Allow-Origin", "*");

  return new Response(response.body, {
    status: 200,
    headers: respHeaders,
  });
}

// ---------------------------------------------------------------------------
//  Bare v2 server (WebSocket)
// ---------------------------------------------------------------------------
async function handleBareWebSocket(request) {
  const bareUrl = request.headers.get("X-Bare-URL");
  if (!bareUrl) {
    return new Response("Missing X-Bare-URL header", { status: 400 });
  }

  const bareHeadersJson = request.headers.get("X-Bare-Headers") || "{}";
  let bareHeaders;
  try {
    bareHeaders = JSON.parse(bareHeadersJson);
  } catch {
    return new Response("Invalid X-Bare-Headers JSON", { status: 400 });
  }

  const fetchHeaders = new Headers();
  for (const [key, value] of Object.entries(bareHeaders)) {
    if (Array.isArray(value)) {
      for (const v of value) fetchHeaders.append(key, v);
    } else {
      fetchHeaders.set(key, value);
    }
  }
  fetchHeaders.set("Upgrade", "websocket");

  const [client, server] = new WebSocketPair();

  try {
    const targetResponse = await fetch(bareUrl, {
      method: request.method,
      headers: fetchHeaders,
      body: request.body,
    });

    if (targetResponse.status !== 101) {
      return new Response(
        `Target did not upgrade (status ${targetResponse.status})`,
        { status: 502 }
      );
    }

    const targetWs = targetResponse.webSocket;
    if (!targetWs) {
      return new Response("Target response missing WebSocket", { status: 502 });
    }

    targetWs.accept();
    server.accept();

    targetWs.addEventListener("message", (evt) => {
      try { server.send(evt.data); } catch {}
    });
    server.addEventListener("message", (evt) => {
      try { targetWs.send(evt.data); } catch {}
    });
    targetWs.addEventListener("close", () => {
      try { server.close(); } catch {}
    });
    server.addEventListener("close", () => {
      try { targetWs.close(); } catch {}
    });
    targetWs.addEventListener("error", () => {
      try { server.close(); } catch {}
    });
    server.addEventListener("error", () => {
      try { targetWs.close(); } catch {}
    });
  } catch (err) {
    return new Response(err.message, { status: 502 });
  }

  return new Response(null, { status: 101, webSocket: client });
}

// ---------------------------------------------------------------------------
//  Main handler
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- CORS preflight (global) -----------------------------------------
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS });
    }

    // --- Normalise GAMP path ---------------------------------------------
    const gamp = normalizeGamp(url);
    const path = gamp.assetPath;

    // --- Bare server ------------------------------------------------------
    if (path.startsWith(BARE_PATH)) {
      return handleBare(request);
    }

    // --- Sitemap ----------------------------------------------------------
    if (path === "/sitemap.xml") {
      const sitemap = generateSitemap(gamp.workerOrigin);
      return new Response(sitemap, {
        headers: {
          "Content-Type": "application/xml",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=3600",
        },
      });
    }

    // --- Robots.txt -------------------------------------------------------
    if (path === "/robots.txt") {
      const robots = `User-agent: *\nAllow: /\n\nSitemap: ${gamp.workerOrigin}/sitemap.xml`;
      return new Response(robots, {
        headers: {
          "Content-Type": "text/plain",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=3600",
        },
      });
    }

    // --- Static assets ----------------------------------------------------
    // Create a request with the normalised path so env.ASSETS finds the file
    const assetUrl = new URL(path + url.search, "http://localhost");
    let assetRequest = new Request(assetUrl, request);
    let assetResponse = await env.ASSETS.fetch(assetRequest);

    // SPA fallback: if no file extension, try index.html
    const lastSegment = path.split("/").pop();
    const hasExtension = lastSegment.includes(".");
    if (
      assetResponse.status === 404 &&
      !hasExtension &&
      request.method !== "OPTIONS"
    ) {
      const indexUrl = new URL("/index.html", "http://localhost");
      const indexRequest = new Request(indexUrl, request);
      assetResponse = await env.ASSETS.fetch(indexRequest);
    }

    const contentType = (assetResponse.headers.get("content-type") || "").toLowerCase();

    // --- HTML: URL rewriting + optional font-bomb -------------------------
    if (contentType.includes("text/html")) {
      const rawHtml = await assetResponse.text();
      const html = rewriteHtml(rawHtml, gamp.workerOrigin);

      if (gamp.isGamp) {
        // Font-bomb required so Google AMP caches the HTML as application/octet-stream
        const htmlBytes = new TextEncoder().encode(html);
        return new Response(fontBomb(htmlBytes), {
          status: assetResponse.status,
          statusText: assetResponse.statusText,
          headers: AMP_HTML_HEADERS,
        });
      }

      // Direct access: serve normally as text/html
      return new Response(html, {
        status: assetResponse.status,
        statusText: assetResponse.statusText,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=180, stale-while-revalidate=300",
          Vary: "Accept",
        },
      });
    }

    // --- Non-HTML passthrough --------------------------------------------
    const passthroughHeaders = new Headers(assetResponse.headers);
    passthroughHeaders.delete("content-encoding");
    passthroughHeaders.delete("content-length");
    passthroughHeaders.delete("set-cookie");
    passthroughHeaders.delete("strict-transport-security");
    passthroughHeaders.delete("content-security-policy");
    passthroughHeaders.delete("x-frame-options");
    passthroughHeaders.set("Cross-Origin-Resource-Policy", "cross-origin");

    for (const [k, v] of Object.entries(AMP_NON_HTML_HEADERS)) {
      passthroughHeaders.set(k, v);
    }

    if (!passthroughHeaders.has("content-type")) {
      passthroughHeaders.set("Content-Type", "application/octet-stream");
    }

    return new Response(assetResponse.body, {
      status: assetResponse.status,
      statusText: assetResponse.statusText,
      headers: passthroughHeaders,
    });
  },
};
