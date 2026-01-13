// /api/youtube_analyzer.js
// Vercel Serverless Function (YouTube Data API v3 proxy)
// - Does NOT generate insights. Only fetches data.
// - Uses env: YOUTUBE_API_KEY

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const action = String(req.query.action || "bundle");

    // Lightweight health check (no API key required)
    if (action === "ping") {
      return res.status(200).json({ ok: true, now: new Date().toISOString() });
    }

    const key = process.env.YOUTUBE_API_KEY;
    if (!key) {
      return res.status(500).json({
        error: { message: "서버에 YOUTUBE_API_KEY가 설정되지 않았습니다. Vercel Environment Variables를 확인하세요." }
      });
    }

    if (action !== "bundle") {
      return res.status(400).json({ error: { message: "Invalid action. Use action=bundle (or action=ping)" } });
    }

    const input = (req.query.input || "").toString().trim();

    const max = clampInt(req.query.max, 10, 1, 100);
    const days = clampInt(req.query.days, 30, 1, 3650);
    const region = (req.query.region || "KR").toString().trim() || "KR";
    const lang = (req.query.lang || "ko").toString().trim() || "ko";
    const allowSearchFallback = (req.query.allowSearchFallback || "1").toString() === "1";
    const lite = (req.query.lite || "0").toString() === "1";

    if (!input) {
      return res.status(400).json({ error: { message: "input is required" } });
    }

    const quota = makeQuotaTracker();

    // 1) Resolve channel (id + uploads playlist)
    const channelResolved = await resolveChannel(input, key, allowSearchFallback, quota);
    if (!channelResolved) {
      return res.status(404).json({ error: { message: "채널을 찾지 못했습니다. 입력값(URL/@handle/UC...)을 확인하세요." } });
    }

    // 2) Fetch videos from uploads playlist (cheap)
    const videoIds = await fetchUploadsVideoIds(channelResolved.uploadsPlaylistId, key, max, days, quota);

    // 3) Fetch video details
    let videos = [];
    if (videoIds.length) {
      if (lite) {
        // Lite: only snippet (no stats/duration)
        videos = await fetchVideoDetails(videoIds, key, quota, { parts: ["snippet"], lite: true });
      } else {
        videos = await fetchVideoDetails(videoIds, key, quota, { parts: ["snippet","contentDetails","statistics"], lite: false });
      }
    }

    // 4) Category mapping
    let categoryMap = {};
    if (!lite) {
      categoryMap = await fetchCategoryMap(region, key, quota);
    }

    // 5) Normalize output
    const outVideos = videos.map(v => normalizeVideo(v, categoryMap, lite));
    const outChannel = normalizeChannel(channelResolved.channel);

    return res.status(200).json({
      channel: outChannel,
      videos: outVideos,
      categoryMap,
      quota: quota.summary()
    });

  } catch (err) {
    return res.status(500).json({
      error: {
        message: String(err && (err.message || err) || "Unknown error")
      }
    });
  }
}

// ---------- Helpers ----------
function clampInt(v, dflt, min, max){
  const n = parseInt((v ?? "").toString(), 10);
  if (!isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

function makeQuotaTracker(){
  const breakdown = [];
  let units = 0;
  const add = (u, name) => {
    units += u;
    breakdown.push({ endpoint: name, units: u });
  };
  return {
    add,
    summary: () => ({
      estimatedUnitsThisCall: units,
      breakdown
    })
  };
}

function ytUrl(path){
  return "https://www.googleapis.com/youtube/v3/" + path;
}

async function ytFetchJson(url, quota, unitCost, endpointName){
  quota.add(unitCost, endpointName);
  const resp = await fetch(url);
  const data = await resp.json().catch(()=> ({}));
  if (!resp.ok) {
    const msg = data && data.error && data.error.message ? data.error.message : ("HTTP "+resp.status);
    const e = new Error(msg);
    e.status = resp.status;
    e.data = data;
    throw e;
  }
  return data;
}

// ---------- Resolve channel ----------
function parseChannelInput(input){
  const s = input.trim();

  // channelId
  if (/^UC[\w-]{20,}$/.test(s)) return { type:"id", value: s };

  // URL forms
  try{
    if (s.startsWith("http://") || s.startsWith("https://")) {
      const u = new URL(s);
      const p = u.pathname || "";
      const m1 = p.match(/\/channel\/(UC[\w-]{20,})/);
      if (m1) return { type:"id", value: m1[1] };
      const m2 = p.match(/\/@([\w\.-]{2,})/);
      if (m2) return { type:"handle", value: "@"+m2[1] };
      const m3 = p.match(/\/user\/([\w\.-]{2,})/);
      if (m3) return { type:"query", value: m3[1] };
      // /c/CustomName
      const m4 = p.match(/\/c\/([\w\.-]{2,})/);
      if (m4) return { type:"query", value: m4[1] };
      // /@handle or /something
      const seg = p.split("/").filter(Boolean);
      if (seg.length===1 && seg[0].startsWith("@")) return { type:"handle", value: seg[0] };
    }
  }catch(_){}

  // handle direct
  if (s.startsWith("@") && s.length >= 3) return { type:"handle", value: s };

  // fallback query
  return { type:"query", value: s };
}

async function resolveChannel(input, key, allowSearchFallback, quota){
  const parsed = parseChannelInput(input);

  // Try direct by id
  if (parsed.type === "id") {
    const ch = await channelsById(parsed.value, key, quota);
    if (ch) return ch;
  }

  // Try forHandle
  if (parsed.type === "handle") {
    const ch = await channelsByHandle(parsed.value.replace(/^@/,""), key, quota);
    if (ch) return ch;
  }

  // If parsed.query and allowSearchFallback => search channel
  if (!allowSearchFallback) return null;

  const q = (parsed.value || "").replace(/^@/,"");
  const foundId = await searchChannelId(q, key, quota);
  if (!foundId) return null;
  return await channelsById(foundId, key, quota);
}

async function channelsById(channelId, key, quota){
  const url = ytUrl("channels?part=snippet,contentDetails,statistics&id="+encodeURIComponent(channelId)+"&key="+encodeURIComponent(key));
  const data = await ytFetchJson(url, quota, 1, "channels.list");
  const item = data.items && data.items[0];
  if (!item) return null;
  const uploads = item.contentDetails && item.contentDetails.relatedPlaylists ? item.contentDetails.relatedPlaylists.uploads : null;
  return { channel: item, uploadsPlaylistId: uploads };
}

async function channelsByHandle(handle, key, quota){
  // channels.list supports forHandle (if enabled in API)
  const url = ytUrl("channels?part=snippet,contentDetails,statistics&forHandle="+encodeURIComponent(handle)+"&key="+encodeURIComponent(key));
  try{
    const data = await ytFetchJson(url, quota, 1, "channels.list(forHandle)");
    const item = data.items && data.items[0];
    if (!item) return null;
    const uploads = item.contentDetails && item.contentDetails.relatedPlaylists ? item.contentDetails.relatedPlaylists.uploads : null;
    return { channel: item, uploadsPlaylistId: uploads };
  }catch(e){
    // If forHandle unsupported or 400, fallback to search (costly) handled by caller
    return null;
  }
}

async function searchChannelId(query, key, quota){
  const url = ytUrl("search?part=snippet&type=channel&maxResults=1&q="+encodeURIComponent(query)+"&key="+encodeURIComponent(key));
  const data = await ytFetchJson(url, quota, 100, "search.list(channel)");
  const item = data.items && data.items[0];
  if (!item || !item.snippet || !item.snippet.channelId) return null;
  return item.snippet.channelId;
}

// ---------- Uploads -> video IDs ----------
async function fetchUploadsVideoIds(uploadsPlaylistId, key, max, days, quota){
  if (!uploadsPlaylistId) return [];
  const cutoff = Date.now() - (days * 86400000);
  let ids = [];
  let pageToken = "";
  while (ids.length < max) {
    const left = max - ids.length;
    const pageSize = Math.min(50, left);
    let url = ytUrl("playlistItems?part=snippet,contentDetails&maxResults="+pageSize+
      "&playlistId="+encodeURIComponent(uploadsPlaylistId)+
      "&key="+encodeURIComponent(key));
    if (pageToken) url += "&pageToken="+encodeURIComponent(pageToken);

    const data = await ytFetchJson(url, quota, 1, "playlistItems.list");
    const items = data.items || [];
    for (const it of items) {
      const vid = it.contentDetails && it.contentDetails.videoId;
      const pub = it.contentDetails && it.contentDetails.videoPublishedAt ? Date.parse(it.contentDetails.videoPublishedAt)
                : (it.snippet && it.snippet.publishedAt ? Date.parse(it.snippet.publishedAt) : NaN);
      if (vid) {
        if (isFinite(pub) && pub < cutoff) {
          // playlist is ordered newest first; if we're already past cutoff and have some, we can stop
          if (ids.length > 0) return ids;
          // else keep going to ensure at least something
        } else {
          ids.push(vid);
        }
      }
      if (ids.length >= max) break;
    }
    pageToken = data.nextPageToken || "";
    if (!pageToken) break;
  }
  return ids.slice(0, max);
}

// ---------- Video details ----------
async function fetchVideoDetails(videoIds, key, quota, opts){
  const parts = (opts && opts.parts) ? opts.parts : ["snippet","contentDetails","statistics"];
  const lite = !!(opts && opts.lite);

  const out = [];
  const chunks = chunk(videoIds, 50);
  for (const c of chunks) {
    const url = ytUrl("videos?part="+encodeURIComponent(parts.join(","))+
      "&id="+encodeURIComponent(c.join(","))+
      "&key="+encodeURIComponent(key));
    const data = await ytFetchJson(url, quota, 1, "videos.list");
    const items = data.items || [];
    for (const it of items) out.push(it);
  }
  return out;
}

function chunk(arr, n){
  const out = [];
  for (let i=0;i<arr.length;i+=n) out.push(arr.slice(i,i+n));
  return out;
}

// ---------- Categories ----------
async function fetchCategoryMap(region, key, quota){
  const url = ytUrl("videoCategories?part=snippet&regionCode="+encodeURIComponent(region)+"&key="+encodeURIComponent(key));
  const data = await ytFetchJson(url, quota, 1, "videoCategories.list");
  const items = data.items || [];
  const map = {};
  for (const it of items) {
    if (it.id && it.snippet && it.snippet.title) map[it.id] = it.snippet.title;
  }
  return map;
}

// ---------- Normalize output ----------
function normalizeChannel(ch){
  const sn = ch.snippet || {};
  const st = ch.statistics || {};
  const channelId = ch.id || "";
  const customUrl = sn.customUrl || "";
  // Some channels return customUrl as "@handle"
  const url = channelId ? ("https://www.youtube.com/channel/" + channelId) : "";
  return {
    channelId,
    title: sn.title || "",
    customUrl: customUrl || "",
    handle: customUrl && customUrl.startsWith("@") ? customUrl : "",
    publishedAt: sn.publishedAt || "",
    subscriberCount: st.hiddenSubscriberCount ? null : safeNum(st.subscriberCount),
    viewCount: safeNum(st.viewCount),
    videoCount: safeNum(st.videoCount),
    url
  };
}

function normalizeVideo(v, categoryMap, lite){
  const sn = v.snippet || {};
  const cd = v.contentDetails || {};
  const st = v.statistics || {};
  const categoryId = sn.categoryId || "";
  const url = v.id ? ("https://www.youtube.com/watch?v="+v.id) : "";
  return {
    videoId: v.id,
    url,
    title: sn.title || "",
    publishedAt: sn.publishedAt || "",
    description: sn.description || "",
    categoryId,
    categoryName: (categoryMap && categoryId && categoryMap[categoryId]) ? categoryMap[categoryId] : "",
    duration: lite ? "" : (cd.duration || ""),
    viewCount: lite ? safeNum(st.viewCount) : safeNum(st.viewCount),
    likeCount: lite ? null : safeNum(st.likeCount, true),
    commentCount: lite ? null : safeNum(st.commentCount, true)
  };
}

function safeNum(v, allowNull){
  if (v === undefined || v === null) return allowNull ? null : 0;
  const n = Number(v);
  if (!isFinite(n)) return allowNull ? null : 0;
  return n;
}
