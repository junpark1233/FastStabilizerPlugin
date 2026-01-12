/**
 * /api/youtube.js (Vercel Serverless)
 * - YOUTUBE_API_KEY(환경변수) 사용
 * - 채널/영상 수집: channels.list, search.list, playlistItems.list, videos.list, videoCategories.list
 *
 * 사용 예)
 * 1) 테스트:
 *   /api/youtube?action=ping
 *
 * 2) 채널+영상 N개 수집(핵심):
 *   /api/youtube?action=collect&input=@handle_or_url_or_UC...&n=100&content=all&shortsRule=duration&shortsThreshold=60&region=KR
 *
 * 파라미터
 * - input: 채널 URL / @handle / UC... / channel URL
 * - n: 10/25/50/100 (최대 200까지 허용)
 * - content: all | shorts | long
 * - shortsRule: duration | meta
 * - shortsThreshold: 60 | 120 (duration 규칙일 때만 사용)
 * - region: KR 등 (카테고리 맵핑용)
 */

const memCache = global.__YT_MEM_CACHE__ || new Map();
global.__YT_MEM_CACHE__ = memCache;

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj, null, 2));
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(String(v ?? ""), 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function pickStr(v, fallback = "") {
  if (typeof v !== "string") return fallback;
  return v.trim();
}

function cacheKey(req) {
  const u = new URL(req.url, "http://localhost");
  // force 제외
  const params = [...u.searchParams.entries()]
    .filter(([k]) => k !== "force")
    .sort(([a], [b]) => (a > b ? 1 : -1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return `${u.pathname}?${params}`;
}

async function fetchJson(url) {
  const r = await fetch(url, { method: "GET" });
  const t = await r.text();
  let data = null;
  try { data = JSON.parse(t); } catch { /* ignore */ }
  if (!r.ok) {
    const msg =
      data?.error?.message ||
      `HTTP ${r.status} ${r.statusText} :: ${t.slice(0, 200)}`;
    const e = new Error(msg);
    e.status = r.status;
    e.raw = data || t;
    throw e;
  }
  return data;
}

function parseChannelInput(inputRaw) {
  const input = pickStr(inputRaw, "");
  if (!input) return { type: "empty" };

  // UC... 채널ID
  if (/^UC[a-zA-Z0-9_-]{20,}$/.test(input)) return { type: "channelId", channelId: input };

  // URL
  if (input.includes("youtube.com")) {
    // /channel/UC...
    const m1 = input.match(/\/channel\/(UC[a-zA-Z0-9_-]{20,})/);
    if (m1?.[1]) return { type: "channelId", channelId: m1[1] };

    // /@handle
    const m2 = input.match(/\/@([a-zA-Z0-9._-]+)/);
    if (m2?.[1]) return { type: "handle", handle: m2[1] };

    // 그 외: 일단 검색으로 처리
    return { type: "search", q: input };
  }

  // @handle
  if (input.startsWith("@")) {
    const handle = input.slice(1).trim();
    if (handle) return { type: "handle", handle };
  }

  // 기타 문자열: 채널 검색
  return { type: "search", q: input };
}

function isoDurationToSeconds(iso) {
  // PT#H#M#S
  const m = String(iso || "").match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  const h = parseInt(m[1] || "0", 10);
  const mi = parseInt(m[2] || "0", 10);
  const s = parseInt(m[3] || "0", 10);
  return h * 3600 + mi * 60 + s;
}

function extractHashtags(text) {
  // 한글/영문/숫자/언더스코어 해시태그
  const s = String(text || "");
  const re = /#[\p{L}\p{N}_]+/gu;
  const out = [];
  let m;
  while ((m = re.exec(s))) out.push(m[0]);
  // 중복 제거
  return [...new Set(out)];
}

function daysBetween(aIso, bIso) {
  const a = new Date(aIso).getTime();
  const b = new Date(bIso).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.abs(a - b) / (1000 * 60 * 60 * 24);
}

async function resolveChannelId({ key, parsed }) {
  // handle/search면 search.list로 채널ID 찾기 (cost 100 units)
  if (parsed.type === "channelId") return { channelId: parsed.channelId, quota: 0, via: "channelId" };

  const q =
    parsed.type === "handle"
      ? `@${parsed.handle}`
      : parsed.type === "search"
        ? parsed.q
        : "";

  if (!q) throw new Error("채널 입력이 비어있습니다");

  const url =
    "https://www.googleapis.com/youtube/v3/search" +
    `?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(q)}` +
    `&key=${encodeURIComponent(key)}`;

  const data = await fetchJson(url);
  const item = data?.items?.[0];
  const channelId = item?.snippet?.channelId || item?.id?.channelId;
  if (!channelId) {
    throw new Error("채널을 찾지 못했습니다. @핸들 오타 또는 채널 비공개 여부를 확인해 주세요.");
  }
  return { channelId, quota: 100, via: "search.list" };
}

async function getChannelInfo({ key, channelId }) {
  const url =
    "https://www.googleapis.com/youtube/v3/channels" +
    `?part=snippet,contentDetails,statistics&id=${encodeURIComponent(channelId)}` +
    `&key=${encodeURIComponent(key)}`;

  const data = await fetchJson(url);
  const ch = data?.items?.[0];
  if (!ch) throw new Error("channels.list 결과가 비어있습니다(채널ID 확인 필요)");
  const uploadsPlaylistId = ch?.contentDetails?.relatedPlaylists?.uploads;

  return {
    quota: 1,
    channel: {
      channelId,
      title: ch?.snippet?.title || "",
      customUrl: ch?.snippet?.customUrl || "",
      publishedAt: ch?.snippet?.publishedAt || "",
      thumbnails: ch?.snippet?.thumbnails || {},
      uploadsPlaylistId: uploadsPlaylistId || "",
      statistics: ch?.statistics || {},
    },
  };
}

async function listUploads({ key, uploadsPlaylistId, n }) {
  // playlistItems.list maxResults=50, pageToken 반복
  const want = clampInt(n, 1, 200, 50);
  let pageToken = "";
  const out = [];
  let quota = 0;

  while (out.length < want) {
    const maxResults = Math.min(50, want - out.length);
    const url =
      "https://www.googleapis.com/youtube/v3/playlistItems" +
      `?part=snippet,contentDetails&playlistId=${encodeURIComponent(uploadsPlaylistId)}` +
      `&maxResults=${maxResults}` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "") +
      `&key=${encodeURIComponent(key)}`;

    const data = await fetchJson(url);
    quota += 1;

    const items = data?.items || [];
    for (const it of items) {
      const vid = it?.contentDetails?.videoId;
      if (!vid) continue;
      out.push({
        videoId: vid,
        publishedAt: it?.contentDetails?.videoPublishedAt || it?.snippet?.publishedAt || "",
        title: it?.snippet?.title || "",
        description: it?.snippet?.description || "",
        thumbnails: it?.snippet?.thumbnails || {},
      });
    }

    pageToken = data?.nextPageToken || "";
    if (!pageToken || items.length === 0) break;
  }

  return { quota, items: out.slice(0, want) };
}

async function getVideoDetailsBatched({ key, ids }) {
  // videos.list id 최대 50개
  let quota = 0;
  const out = [];

  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const url =
      "https://www.googleapis.com/youtube/v3/videos" +
      `?part=snippet,contentDetails,statistics&id=${encodeURIComponent(batch.join(","))}` +
      `&key=${encodeURIComponent(key)}`;
    const data = await fetchJson(url);
    quota += 1;

    const items = data?.items || [];
    for (const v of items) out.push(v);
  }

  return { quota, items: out };
}

async function getCategoryMap({ key, region }) {
  const url =
    "https://www.googleapis.com/youtube/v3/videoCategories" +
    `?part=snippet&regionCode=${encodeURIComponent(region || "KR")}` +
    `&key=${encodeURIComponent(key)}`;
  const data = await fetchJson(url);
  const map = {};
  for (const it of data?.items || []) {
    const id = it?.id;
    const title = it?.snippet?.title;
    if (id && title) map[id] = title;
  }
  return { quota: 1, map };
}

function computeRates(stats) {
  const views = Number(stats?.viewCount ?? NaN);
  const likes = Number(stats?.likeCount ?? NaN);
  const comments = Number(stats?.commentCount ?? NaN);

  const out = {
    views: Number.isFinite(views) ? views : null,
    likes: Number.isFinite(likes) ? likes : null,
    comments: Number.isFinite(comments) ? comments : null,
    likeRate: null,
    commentRate: null,
  };

  if (out.views && out.likes != null) out.likeRate = out.likes / out.views;
  if (out.views && out.comments != null) out.commentRate = out.comments / out.views;

  return out;
}

module.exports = async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  // CDN cache
  res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=120");

  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    return json(res, 400, {
      ok: false,
      error: "YOUTUBE_API_KEY 환경변수가 없습니다",
      howToFix:
        "Vercel → (이 프로젝트) Settings → Environment Variables 에 YOUTUBE_API_KEY 를 추가하세요. '새 프로젝트'로 배포했다면 거기에 다시 등록해야 합니다.",
    });
  }

  const u = new URL(req.url, "http://localhost");
  const action = pickStr(u.searchParams.get("action"), "collect");
  const force = pickStr(u.searchParams.get("force"), "") === "1";
  const cacheTtlSec = clampInt(u.searchParams.get("cacheTtlSec"), 10, 3600, 120);

  const keyCache = cacheKey(req);
  const cached = memCache.get(keyCache);
  if (!force && cached && Date.now() - cached.t < cacheTtlSec * 1000) {
    return json(res, 200, { ok: true, cached: true, ...cached.v });
  }

  try {
    if (action === "ping") {
      const payload = { ok: true, cached: false, message: "youtube api proxy alive" };
      memCache.set(keyCache, { t: Date.now(), v: payload });
      return json(res, 200, payload);
    }

    if (action !== "collect") {
      return json(res, 400, { ok: false, error: "지원하지 않는 action 입니다", hint: "action=collect | ping" });
    }

    const input = pickStr(u.searchParams.get("input"), "");
    const n = clampInt(u.searchParams.get("n"), 1, 200, 100);
    const content = pickStr(u.searchParams.get("content"), "all"); // all|shorts|long
    const shortsRule = pickStr(u.searchParams.get("shortsRule"), "duration"); // duration|meta
    const shortsThreshold = clampInt(u.searchParams.get("shortsThreshold"), 10, 300, 60); // 60|120
    const region = pickStr(u.searchParams.get("region"), "KR");

    if (!input) {
      return json(res, 400, { ok: false, error: "input(채널 URL/@handle/UC...)이 필요합니다" });
    }

    const parsed = parseChannelInput(input);

    let quota = 0;

    // 1) 채널ID 찾기
    const resolved = await resolveChannelId({ key, parsed });
    quota += resolved.quota;

    // 2) 채널 정보 + uploads playlist
    const chInfo = await getChannelInfo({ key, channelId: resolved.channelId });
    quota += chInfo.quota;

    const uploadsPlaylistId = chInfo.channel.uploadsPlaylistId;
    if (!uploadsPlaylistId) {
      return json(res, 400, {
        ok: false,
        error: "업로드 재생목록(uploads playlist)을 찾지 못했습니다",
        tip: "채널이 제한되어 있거나 API가 일부 정보를 반환하지 않는 경우가 있습니다.",
      });
    }

    // 3) 업로드 영상 목록 N개
    const uploads = await listUploads({ key, uploadsPlaylistId, n });
    quota += uploads.quota;

    const videoIds = uploads.items.map((x) => x.videoId);
    // 4) 영상 상세 (조회수/댓글/길이/태그/카테고리)
    const details = await getVideoDetailsBatched({ key, ids: videoIds });
    quota += details.quota;

    // 5) 카테고리 맵
    const catMap = await getCategoryMap({ key, region });
    quota += catMap.quota;

    // 병합
    const uploadMap = new Map(uploads.items.map((x) => [x.videoId, x]));
    const videos = details.items.map((v) => {
      const id = v?.id;
      const up = uploadMap.get(id) || {};
      const sn = v?.snippet || {};
      const cd = v?.contentDetails || {};
      const st = v?.statistics || {};

      const durationSec = isoDurationToSeconds(cd?.duration);
      const isShortByDuration = durationSec > 0 && durationSec <= shortsThreshold;
      const isShortByMeta = /#shorts/i.test(sn?.title || "") || /#shorts/i.test(sn?.description || "");

      const isShort = shortsRule === "meta" ? isShortByMeta : isShortByDuration;

      const pub = up.publishedAt || sn.publishedAt || "";
      const ageDays = daysBetween(pub, new Date().toISOString()) ?? null;

      const rates = computeRates(st);
      const viewPerDay =
        rates.views != null && ageDays != null && ageDays > 0 ? rates.views / ageDays : null;

      const hashtags = extractHashtags(sn?.description || up.description || "");

      return {
        videoId: id,
        url: id ? `https://www.youtube.com/watch?v=${id}` : "",
        title: sn?.title || up.title || "",
        publishedAt: pub,
        ageDays,
        durationISO: cd?.duration || "",
        durationSec,
        shorts: {
          rule: shortsRule,
          threshold: shortsThreshold,
          isShort,
          isShortByDuration,
          isShortByMeta,
        },
        stats: {
          views: rates.views,
          likes: rates.likes,
          comments: rates.comments,
          viewPerDay,
          likeRate: rates.likeRate,
          commentRate: rates.commentRate,
        },
        category: {
          categoryId: sn?.categoryId || null,
          categoryTitle: sn?.categoryId ? (catMap.map[sn.categoryId] || "미제공") : "미제공",
        },
        tags: Array.isArray(sn?.tags) ? sn.tags : null, // 없으면 null
        hashtags,
        description: sn?.description || "",
        thumbnails: sn?.thumbnails || up.thumbnails || {},
      };
    });

    // content 필터 적용
    const filtered = videos.filter((v) => {
      if (content === "shorts") return v.shorts.isShort === true;
      if (content === "long") return v.shorts.isShort === false;
      return true;
    });

    // 간단 요약
    const viewsArr = filtered.map((v) => v.stats.views).filter((x) => typeof x === "number");
    viewsArr.sort((a, b) => a - b);
    const medianViews = viewsArr.length ? viewsArr[Math.floor(viewsArr.length / 2)] : null;

    const payload = {
      ok: true,
      cached: false,
      input,
      resolved: { channelId: resolved.channelId, via: resolved.via },
      params: { n, content, shortsRule, shortsThreshold, region },
      quotaEstimateUnits: quota,
      channel: {
        ...chInfo.channel,
        statistics: {
          subscriberCount: chInfo.channel.statistics?.subscriberCount ?? null,
          viewCount: chInfo.channel.statistics?.viewCount ?? null,
          videoCount: chInfo.channel.statistics?.videoCount ?? null,
        },
      },
      summary: {
        fetched: videos.length,
        filtered: filtered.length,
        medianViews,
        note:
          "CTR/시청지속시간/유지율은 공개 데이터가 아니라서 API로 가져올 수 없습니다(추정 불가로 표기).",
      },
      videos: filtered,
    };

    memCache.set(keyCache, { t: Date.now(), v: payload });
    return json(res, 200, payload);
  } catch (e) {
    const msg = pickStr(e?.message, "알 수 없는 오류");
    return json(res, e?.status && Number.isInteger(e.status) ? e.status : 500, {
      ok: false,
      error: msg,
      tip:
        "자주 발생하는 원인: (1) 이 Vercel 프로젝트에 YOUTUBE_API_KEY 미등록 (2) 키 제한을 HTTP Referrer로 걸어둠 (3) YouTube API 쿼터 초과 (4) 채널 입력값 오타",
    });
  }
};
