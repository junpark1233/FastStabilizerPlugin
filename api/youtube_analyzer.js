// /api/youtube_analyzer.js
// Vercel Serverless Function (Node.js)
// 목적: YouTube Data API v3 프록시 + 채널 입력(URL/@handle/채널ID) 해석 + (선택) search fallback
//
// ⚠️ 주의: 이 파일은 /api/trends.js 와 완전히 독립적으로 동작하도록 설계됨 (덮어쓰기/수정 없음)

export default async function handler(req, res) {
  // CORS (같은 오리진이더라도 안전하게)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  // 캐시(짧게) - 프록시 응답은 공개 데이터, 서버 부담 완화
  res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=120");

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    return json(res, 500, { message: "환경변수 YOUTUBE_API_KEY가 설정되어 있지 않습니다. (Vercel Settings → Environment Variables)" });
  }

  try {
    const { action } = req.query;
    if (!action) return json(res, 400, { message: "action 파라미터가 필요합니다." });

    // default locale
    const regionCode = String(req.query.regionCode || "KR").toUpperCase();
    const hl = String(req.query.hl || (regionCode === "KR" ? "ko_KR" : "en_US"));

    if (action === "resolve") {
      const input = String(req.query.input || "").trim();
      const allowSearchFallback = String(req.query.allowSearchFallback || "1") === "1";
      if (!input) return json(res, 400, { message: "input 파라미터가 비어있습니다." });

      const resolved = await resolveChannelId({ input, apiKey, regionCode, hl, allowSearchFallback });
      return json(res, 200, { data: resolved.data, meta: resolved.meta });
    }

    // Direct proxies
    if (action === "channels") {
      const id = String(req.query.id || "").trim();
      const forHandle = String(req.query.forHandle || "").trim();
      const forUsername = String(req.query.forUsername || "").trim();
      const part = String(req.query.part || "snippet,statistics,contentDetails").trim();

      // exactly one filter should be provided (id, forHandle, forUsername)
      const params = { part };
      if (id) params.id = id;
      else if (forHandle) params.forHandle = forHandle.replace(/^@/, "");
      else if (forUsername) params.forUsername = forUsername;
      else return json(res, 400, { message: "channels: id 또는 forHandle 또는 forUsername 중 하나가 필요합니다." });

      const data = await ytGet("/youtube/v3/channels", params, apiKey);
      return json(res, 200, { data, meta: metaFor("channels.list", 1, "Channels: list") });
    }

    if (action === "playlistItems") {
      const playlistId = String(req.query.playlistId || "").trim();
      const part = String(req.query.part || "contentDetails,snippet").trim();
      const maxResults = clampInt(req.query.maxResults, 1, 50, 50);
      const pageToken = String(req.query.pageToken || "").trim();

      if (!playlistId) return json(res, 400, { message: "playlistItems: playlistId가 필요합니다." });

      const params = { part, playlistId, maxResults };
      if (pageToken) params.pageToken = pageToken;

      const data = await ytGet("/youtube/v3/playlistItems", params, apiKey);
      return json(res, 200, { data, meta: metaFor("playlistItems.list", 1, "PlaylistItems: list") });
    }

    if (action === "videos") {
      const id = String(req.query.id || "").trim(); // comma separated video IDs
      const part = String(req.query.part || "snippet,contentDetails,statistics").trim();
      if (!id) return json(res, 400, { message: "videos: id(쉼표로 구분된 videoIds)가 필요합니다." });

      const ids = id.split(",").map(s => s.trim()).filter(Boolean);
      if (ids.length > 50) return json(res, 400, { message: "videos: id는 최대 50개까지 가능합니다." });

      const data = await ytGet("/youtube/v3/videos", { part, id: ids.join(",") }, apiKey);
      return json(res, 200, { data, meta: metaFor("videos.list", 1, "Videos: list") });
    }

    if (action === "videoCategories") {
      const part = String(req.query.part || "snippet").trim();
      const params = { part, regionCode, hl };
      const data = await ytGet("/youtube/v3/videoCategories", params, apiKey);
      return json(res, 200, { data, meta: metaFor("videoCategories.list", 1, "VideoCategories: list") });
    }

    // search fallback (expensive)
    if (action === "searchChannels") {
      const q = String(req.query.q || "").trim();
      if (!q) return json(res, 400, { message: "searchChannels: q가 필요합니다." });
      const maxResults = clampInt(req.query.maxResults, 1, 5, 1);

      const data = await ytGet("/youtube/v3/search", {
        part: "snippet",
        q,
        type: "channel",
        maxResults,
        regionCode
      }, apiKey);

      // search.list quota is expensive (100)
      return json(res, 200, { data, meta: metaFor("search.list", 100, "Search: list (type=channel)") });
    }

    return json(res, 400, { message: `지원하지 않는 action: ${action}` });
  } catch (err) {
    const status = err?.status || 500;
    const message = err?.message || String(err);
    return json(res, status, { message });
  }
}

/* =========================
   Helpers
========================= */

function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function metaFor(action, quotaUnits, label) {
  return { action, quotaUnits, label };
}

async function ytGet(path, params, apiKey) {
  const url = new URL("https://www.googleapis.com" + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, String(v));
  }
  url.searchParams.set("key", apiKey);

  const resp = await fetch(url.toString(), { method: "GET" });
  const text = await resp.text();

  let data = null;
  try { data = JSON.parse(text); } catch { /* ignore */ }

  if (!resp.ok) {
    const msg = data?.error?.message || text || `HTTP ${resp.status}`;
    const e = new Error(msg);
    e.status = resp.status;
    throw e;
  }
  return data;
}

/* =========================
   Channel resolver
   - supports: channelId, @handle, youtube.com/@handle, youtube.com/channel/UC...
   - supports: youtube.com/user/USERNAME (legacy) → channels.list forUsername
   - supports: /c/slug or other unknown URL forms → optional search fallback (100u)
========================= */

function parseChannelInput(input) {
  const raw = input.trim();

  // If it's already a UC channel id
  const uc = raw.match(/^(UC[A-Za-z0-9_-]{20,})$/);
  if (uc) return { kind: "channelId", value: uc[1] };

  // full URL
  try {
    const url = new URL(raw.startsWith("http") ? raw : `https://www.youtube.com/${raw}`);
    const host = url.hostname.replace(/^www\./, "");
    const path = url.pathname;

    // /channel/UCxxxx
    const m1 = path.match(/^\/channel\/(UC[A-Za-z0-9_-]{20,})/);
    if (m1) return { kind: "channelId", value: m1[1] };

    // /@handle
    const m2 = path.match(/^\/@([^\/\?\#]+)/);
    if (m2) return { kind: "handle", value: m2[1] };

    // /user/USERNAME
    const m3 = path.match(/^\/user\/([^\/\?\#]+)/);
    if (m3) return { kind: "username", value: m3[1] };

    // /c/slug (custom url) -> fallback
    const m4 = path.match(/^\/c\/([^\/\?\#]+)/);
    if (m4) return { kind: "custom", value: m4[1] };

    // /@handle might be in raw without domain
    // /something else -> fallback to slug
    const slug = path.replace(/^\/+/, "").split("/")[0];
    if (slug && slug !== "watch" && slug !== "shorts") {
      return { kind: "custom", value: slug };
    }
  } catch {
    // not a URL
  }

  // starts with @
  if (raw.startsWith("@") && raw.length > 1) return { kind: "handle", value: raw.slice(1) };

  // If it looks like a handle-ish string, try handle first then username
  return { kind: "maybeHandleOrUsername", value: raw.replace(/^@/, "") };
}

async function resolveChannelId({ input, apiKey, regionCode, hl, allowSearchFallback }) {
  const parsed = parseChannelInput(input);

  // Helper: channels.list and pick first item
  const fetchChannelBy = async (params, label, quotaUnits=1) => {
    const data = await ytGet("/youtube/v3/channels", { part: "snippet,statistics,contentDetails", ...params }, apiKey);
    const item = data?.items?.[0];
    if (!item) return null;
    const handle = item?.snippet?.customUrl?.startsWith("@") ? item.snippet.customUrl : null;
    return {
      data: { channelId: item.id, handle: handle ? handle.replace(/^@/,"") : null, matchedBy: label },
      meta: metaFor("channels.list", quotaUnits, label)
    };
  };

  if (parsed.kind === "channelId") {
    const out = await fetchChannelBy({ id: parsed.value }, "resolve:channelId");
    if (!out) throw new Error("채널ID로 채널을 찾지 못했습니다.");
    return out;
  }

  if (parsed.kind === "handle") {
    // channels.list supports forHandle (without @)
    const out = await fetchChannelBy({ forHandle: parsed.value }, "resolve:forHandle");
    if (!out) throw new Error("핸들(@)로 채널을 찾지 못했습니다.");
    out.data.handle = parsed.value;
    return out;
  }

  if (parsed.kind === "username") {
    const out = await fetchChannelBy({ forUsername: parsed.value }, "resolve:forUsername");
    if (!out) throw new Error("user/USERNAME로 채널을 찾지 못했습니다.");
    return out;
  }

  // try handle first, then username
  if (parsed.kind === "maybeHandleOrUsername") {
    const out1 = await fetchChannelBy({ forHandle: parsed.value }, "resolve:forHandle(guess)");
    if (out1) { out1.data.handle = parsed.value; return out1; }
    const out2 = await fetchChannelBy({ forUsername: parsed.value }, "resolve:forUsername(guess)");
    if (out2) return out2;

    if (!allowSearchFallback) {
      return {
        data: { channelId: null, handle: null, matchedBy: "resolve:failed(no search)" },
        meta: metaFor("resolve", 0, "resolve failed")
      };
    }

    // expensive fallback: search.list type=channel q=...
    const search = await ytGet("/youtube/v3/search", {
      part: "snippet",
      q: parsed.value,
      type: "channel",
      maxResults: 1,
      regionCode
    }, apiKey);

    const channelId = search?.items?.[0]?.snippet?.channelId || search?.items?.[0]?.id?.channelId || null;
    if (!channelId) throw new Error("search fallback으로도 채널을 찾지 못했습니다.");

    // Now fetch channel details by id
    const data = await ytGet("/youtube/v3/channels", { part: "snippet,statistics,contentDetails", id: channelId }, apiKey);
    const item = data?.items?.[0];
    if (!item) throw new Error("채널 상세 조회 실패(search fallback 이후).");

    return {
      data: { channelId: item.id, handle: item?.snippet?.customUrl?.replace(/^@/,"") || null, matchedBy: "resolve:searchFallback" },
      meta: metaFor("search.list + channels.list", 101, "resolve:searchFallback(100u+1u)")
    };
  }

  // custom url slug path
  if (parsed.kind === "custom") {
    if (!allowSearchFallback) throw new Error("커스텀 URL은 search fallback이 꺼져있어 해석할 수 없습니다.");
    const q = parsed.value;

    const search = await ytGet("/youtube/v3/search", {
      part: "snippet",
      q,
      type: "channel",
      maxResults: 1,
      regionCode
    }, apiKey);

    const channelId = search?.items?.[0]?.snippet?.channelId || search?.items?.[0]?.id?.channelId || null;
    if (!channelId) throw new Error("커스텀 URL 해석 실패(search fallback).");

    const data = await ytGet("/youtube/v3/channels", { part: "snippet,statistics,contentDetails", id: channelId }, apiKey);
    const item = data?.items?.[0];
    if (!item) throw new Error("채널 상세 조회 실패(search fallback 이후).");

    return {
      data: { channelId: item.id, handle: item?.snippet?.customUrl?.replace(/^@/,"") || null, matchedBy: "resolve:customUrl(searchFallback)" },
      meta: metaFor("search.list + channels.list", 101, "resolve:customUrl(searchFallback 100u+1u)")
    };
  }

  throw new Error("채널 입력을 해석할 수 없습니다.");
}
