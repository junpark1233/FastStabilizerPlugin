// /api/trends.js
// Vercel Serverless Function - 단일 파일 프록시
// - CORS 대응
// - CDN/메모리 캐시
// - 소스 플러그형: youtube / naver / reddit / googleTrends / news / hackernews / mock
// - 레딧은 403(핫.json 차단) 잦아서 RSS/Atom만 사용해 안정화
//
// 지원 쿼리 파라미터(둘 다 지원)
//   source=reddit|naver|youtube|googleTrends|news|hackernews|mock
//   timeframe=hour|day|week|month   (또는 tf)
//   country=KR                     (또는 geo)
//   lang=ko                        (또는 hl)
//   cat=all                        (선택)
//   q=검색필터                      (선택)
//
// ENV
//   YT_KEY or YOUTUBE_API_KEY
//   NAVER_CLIENT_ID, NAVER_CLIENT_SECRET
//   NAVER_SEEDS (선택) - 있으면 후보에 섞음
//   NAVER_CANDIDATES (선택, 기본 35)
//   REDDIT_SUBS (선택) - "worldnews,technology,programming,korea"

export default async function handler(req, res) {
  // ---- CORS ----
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  // ---- CDN 캐시 ----
  // 개인용 호출수 절감: 60초 CDN 캐시 + 최대 5분 stale 허용
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");

  const startedAt = Date.now();

  try {
    const source = normalizeSource((req.query.source ?? "mock").toString());

    const tf = normalizeTf(((req.query.tf ?? req.query.timeframe ?? "hour") || "hour").toString());
    const geo = (((req.query.geo ?? req.query.country ?? "KR") || "KR").toString()).toUpperCase();
    const hl = (((req.query.hl ?? req.query.lang ?? "ko") || "ko").toString()).toLowerCase();
    const cat = ((req.query.cat ?? "all") || "all").toString();
    const q = ((req.query.q ?? "") || "").toString().trim();

    const cacheKey = JSON.stringify({ source, tf, geo, hl, cat, q });
    const fresh = memGet(cacheKey, 45_000); // 45초 메모리 캐시
    if (fresh) return res.status(200).json(withMeta(fresh, { tookMs: Date.now() - startedAt }));

    const stale = memGetAny(cacheKey); // TTL 무시(마지막 결과)
    let payload;

    try {
      payload = await dispatchProvider({ source, tf, geo, hl, cat });
    } catch (err) {
      // 실패 시: stale 있으면 stale 반환, 없으면 mock
      if (stale) {
        payload = {
          ...stale,
          meta: {
            ...(stale.meta || {}),
            stale: true,
            staleReason: err?.message || String(err),
          },
        };
      } else {
        payload = makeMock(tf, geo, hl, {
          note: `provider 실패 → mock: ${err?.message || String(err)}`,
          isMock: true,
        });
      }
    }

    // 서버측 q 필터
    if (q && Array.isArray(payload?.items)) {
      const qq = q.toLowerCase();
      payload.items = payload.items.filter((x) => String(x.term || "").toLowerCase().includes(qq));
      payload.items.forEach((x, i) => (x.rank = i + 1));
    }

    payload = withMeta(payload, { tookMs: Date.now() - startedAt });

    memSet(cacheKey, payload);
    memSetAny(cacheKey, payload);

    return res.status(200).json(payload);
  } catch (e) {
    // 여기로 떨어지면 Vercel이 HTML 오류 페이지 내보낼 수 있어서 JSON으로 고정
    return res.status(500).json({ error: e?.message || String(e) });
  }
}

function withMeta(payload, extra) {
  const out = payload || {};
  out.meta = out.meta || {};
  out.meta.tookMs = extra?.tookMs ?? out.meta.tookMs;
  out.meta.fetchedAt = out.meta.fetchedAt || nowIso();
  return out;
}

/* -----------------------
 * In-memory cache (serverless라 영속 X, 그래도 호출 줄이는데 도움)
 * ---------------------- */
function memMap() {
  globalThis.__TRENDS_PROXY_CACHE__ ||= new Map();
  return globalThis.__TRENDS_PROXY_CACHE__;
}
function memGet(key, ttlMs) {
  const m = memMap();
  const v = m.get(key);
  if (!v) return null;
  if (!v.ts) return null;
  if (Date.now() - v.ts > ttlMs) return null;
  return v.data;
}
function memSet(key, data) {
  const m = memMap();
  m.set(key, { ts: Date.now(), data });
}
function memGetAny(key) {
  const m = memMap();
  const v = m.get(key);
  return v?.data || null;
}
function memSetAny(key, data) {
  const m = memMap();
  m.set(key, { ts: Date.now(), data });
}

/* -----------------------
 * Normalizers
 * ---------------------- */
function normalizeSource(s) {
  const x = String(s || "").toLowerCase();
  if (x.includes("youtube")) return "youtube";
  if (x.includes("naver")) return "naver";
  if (x.includes("reddit")) return "reddit";
  if (x.includes("trend")) return "googleTrends";
  if (x === "news" || x.includes("googlenews")) return "news";
  if (x.includes("hacker")) return "hackernews";
  if (x === "mock") return "mock";
  return x;
}
function normalizeTf(tf) {
  const t = String(tf || "hour").toLowerCase();
  if (t.startsWith("h")) return "hour";
  if (t.startsWith("d")) return "day";
  if (t.startsWith("w")) return "week";
  if (t.startsWith("m")) return "month";
  return "hour";
}
function bucketCount(tf) {
  if (tf === "hour") return 24;
  if (tf === "day") return 7;
  if (tf === "week") return 8;
  if (tf === "month") return 12;
  return 24;
}
function nowIso() {
  return new Date().toISOString();
}

/* -----------------------
 * Provider dispatcher
 * ---------------------- */
async function dispatchProvider({ source, tf, geo, hl, cat }) {
  if (source === "mock") return makeMock(tf, geo, hl, { note: "proxy mock", isMock: true });

  if (source === "hackernews") return fromHackerNews({ tf, geo, hl });

  if (source === "youtube") {
    const key = process.env.YT_KEY || process.env.YOUTUBE_API_KEY;
    if (!key) return makeMock(tf, geo, hl, { note: "YT_KEY/YOUTUBE_API_KEY 없음 → mock", isMock: true });
    return fromYouTubeMostPopular({ tf, geo, hl, key });
  }

  if (source === "reddit") return fromRedditRssOnly({ tf, geo, hl });

  if (source === "googleTrends") return fromGoogleTrendsRss({ tf, geo, hl, cat });

  if (source === "news") return fromGoogleNewsRss({ tf, geo, hl });

  if (source === "naver") {
    const id = process.env.NAVER_CLIENT_ID;
    const secret = process.env.NAVER_CLIENT_SECRET;
    if (!id || !secret) return makeMock(tf, geo, hl, { note: "NAVER_CLIENT_ID/SECRET 없음 → mock", isMock: true });
    return fromNaverDataLabDiscover({ tf, geo, hl, clientId: id, clientSecret: secret });
  }

  // 알 수 없는 소스면 mock
  return makeMock(tf, geo, hl, { note: `unknown source(${source}) → mock`, isMock: true });
}

/* -----------------------
 * Fetch helpers (timeout + text/json)
 * ---------------------- */
async function fetchText(url, opts = {}) {
  const timeoutMs = clampInt(opts.timeoutMs ?? 9000, 1000, 20000);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: controller.signal });
    const text = await r.text();
    return { ok: r.ok, status: r.status, text, headers: r.headers };
  } finally {
    clearTimeout(t);
  }
}
async function fetchJson(url, opts = {}) {
  const r = await fetchText(url, opts);
  if (!r.ok) return { ...r, json: null };
  try {
    return { ...r, json: JSON.parse(r.text) };
  } catch {
    return { ...r, json: null };
  }
}
function clampInt(n, min, max) {
  const x = Number.isFinite(+n) ? +n : min;
  return Math.min(max, Math.max(min, x));
}

/* -----------------------
 * RSS/Atom parsing (공용)
 * ---------------------- */
function decodeXml(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}
function stripHtml(s) {
  return String(s).replace(/<[^>]+>/g, "");
}
// RSS(<item><title>) + Atom(<entry><title>) 지원
function parseFeedTitles(xmlText) {
  if (!xmlText || typeof xmlText !== "string") return [];
  const titles = [];
  const pushTitle = (raw) => {
    const t = stripHtml(decodeXml(raw)).trim();
    if (t && t.length >= 2) titles.push(t);
  };

  let m;
  const rssRe = /<item[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<\/item>/gi;
  while ((m = rssRe.exec(xmlText)) !== null) pushTitle(m[1]);

  const atomRe = /<entry[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>[\s\S]*?<\/entry>/gi;
  while ((m = atomRe.exec(xmlText)) !== null) pushTitle(m[1]);

  return Array.from(new Set(titles));
}

/* -----------------------
 * Tokenization + scoring
 * ---------------------- */
function buildStop(hl) {
  const en = [
    "the","a","an","and","or","to","of","in","on","for","with","is","are","was","were","be","from",
    "vs","ver","feat","official","mv","teaser","trailer","full","live","episode","ep","part",
    "new","update","today","breaking",
  ];
  const ko = [
    "영상","공식","라이브","뮤비","예고","티저","하이라이트","리뷰","반응","요약","뉴스","속보","단독",
    "오늘","지금","최신","화제","사건","사고","인터뷰","출연","공개","발표",
  ];
  const set = new Set();
  for (const w of en) set.add(w);
  for (const w of ko) set.add(w);
  return set;
}

function tokenizeMixed(text, hl) {
  const s = String(text || "");
  const stop = buildStop(hl);

  // 한글 덩어리 / 영문+숫자 덩어리 추출
  const tokens = [];
  const hangul = s.match(/[가-힣]{2,}/g) || [];
  for (const t of hangul) tokens.push(t);

  const latin = s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

  for (const t of latin) tokens.push(t);

  const out = [];
  for (let tok of tokens) {
    tok = String(tok).trim();
    if (tok.length < 2) continue;
    if (/^\d+$/.test(tok)) continue;
    if (stop.has(tok)) continue;
    out.push(tok);
  }
  return out;
}

function deriveFromTitles(titles, hl, maxTerms = 80) {
  const freq = new Map();
  const related = new Map(); // term -> Map(other -> count)

  for (const title of titles) {
    const toks = Array.from(new Set(tokenizeMixed(title, hl)));
    for (const t of toks) freq.set(t, (freq.get(t) || 0) + 1);

    // co-occur
    for (let i = 0; i < toks.length; i++) {
      const a = toks[i];
      if (!related.has(a)) related.set(a, new Map());
      const m = related.get(a);
      for (let j = 0; j < toks.length; j++) {
        if (i === j) continue;
        const b = toks[j];
        m.set(b, (m.get(b) || 0) + 1);
      }
    }
  }

  const top = Array.from(freq.entries())
    .sort((x, y) => y[1] - x[1])
    .slice(0, maxTerms)
    .map(([term, count]) => ({ term, count }));

  const relatedList = (term) => {
    const m = related.get(term);
    if (!m) return [];
    return Array.from(m.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([t]) => t);
  };

  return { top, relatedList };
}

function synthSeries(n, base) {
  const slope = (Math.random() - 0.5) * 0.9;
  const vol = 0.18 + Math.random() * 0.22;
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1 || 1);
    const v = base * (0.85 + 0.35 * t + slope * (t - 0.5)) * (1 + (Math.random() - 0.5) * vol);
    out.push(Math.max(0, Math.round(v)));
  }
  return out;
}
function scoreFromSeries(series) {
  const last = series[series.length - 1] || 0;
  const prev = series[Math.max(0, series.length - 2)] || 0;
  const delta = last - prev;
  return Math.round(last + delta * 0.6);
}
function makeLinks(term, geo, hl) {
  return {
    google: "https://www.google.com/search?q=" + encodeURIComponent(term),
    youtube: "https://www.youtube.com/results?search_query=" + encodeURIComponent(term),
    news: "https://news.google.com/search?q=" + encodeURIComponent(term) + `&hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(geo)}`,
    reddit: "https://www.reddit.com/search/?q=" + encodeURIComponent(term),
  };
}
function topN(items, n = 20) {
  const arr = Array.isArray(items) ? items.slice() : [];
  arr.sort((a, b) => (b.score || 0) - (a.score || 0));
  return arr.slice(0, n).map((x, i) => ({ ...x, rank: i + 1 }));
}

/* -----------------------
 * Mock
 * ---------------------- */
function makeMock(tf, geo, hl, metaExtra = {}) {
  const n = bucketCount(tf);
  const terms = [
    "테슬라","비트코인","AI","아이폰","금리","환율","유튜브","넷플릭스","엔비디아","나스닥",
    "코스피","부동산","다이어트","여행","반도체","전기차","CPI","FOMC","ETF","코인",
  ];
  const items = terms.map((term) => {
    const base = 50 + Math.floor(Math.random() * 120);
    const series = synthSeries(n, base);
    return {
      term,
      series,
      score: scoreFromSeries(series),
      related: [term + " 전망", term + " 뉴스", term + " 분석", term + " 가격"].slice(0, 4),
      links: makeLinks(term, geo, hl),
    };
  });

  return {
    items: topN(items, 20),
    meta: {
      source: "mock",
      isMock: true,
      seriesIsSynthetic: true,
      fetchedAt: nowIso(),
      ...metaExtra,
    },
  };
}

/* -----------------------
 * Reddit (RSS/Atom only) - 403 회피
 * ---------------------- */
async function fromRedditRssOnly({ tf, geo, hl }) {
  const n = bucketCount(tf);
  const subsEnv = (process.env.REDDIT_SUBS || "worldnews,technology,programming,korea").toString();
  const subs = subsEnv.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 12);

  const titles = [];
  const errors = [];

  for (const sub of subs) {
    const url = `https://www.reddit.com/r/${encodeURIComponent(sub)}/hot.rss`;
    const r = await fetchText(url, {
      timeoutMs: 9000,
      headers: {
        "User-Agent": "trends-proxy/1.0 (personal use)",
        "Accept": "application/rss+xml, application/atom+xml, text/xml;q=0.9, */*;q=0.8",
      },
    });

    if (r.ok && r.text) {
      const t = parseFeedTitles(r.text);
      for (const x of t) titles.push(x);
    } else {
      errors.push({ sub, rssStatus: r.status });
    }
  }

  if (titles.length < 5) {
    return makeMock(tf, geo, hl, {
      source: "reddit",
      note: "reddit RSS 결과 부족/실패 → mock fallback",
      isMock: true,
      debug: { errors },
    });
  }

  const { top, relatedList } = deriveFromTitles(titles, hl, 80);

  const items = top.map(({ term, count }, idx) => {
    const base = Math.max(25, count * 18);
    const series = synthSeries(n, base);
    return {
      term,
      series,
      score: scoreFromSeries(series),
      related: relatedList(term).slice(0, 8),
      links: makeLinks(term, geo, hl),
    };
  });

  return {
    items: topN(items, 20),
    meta: {
      source: "reddit",
      isMock: false,
      seriesIsSynthetic: true,
      note: "Reddit hot RSS/Atom 제목 토큰 빈도 기반 근사",
      fetchedAt: nowIso(),
      debug: errors.length ? { errors } : undefined,
    },
  };
}

/* -----------------------
 * YouTube MostPopular
 * ---------------------- */
async function fromYouTubeMostPopular({ tf, geo, hl, key }) {
  const n = bucketCount(tf);

  const url = new URL("https://www.googleapis.com/youtube/v3/videos");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("chart", "mostPopular");
  url.searchParams.set("maxResults", "50");
  url.searchParams.set("regionCode", geo || "KR");
  url.searchParams.set("key", key);

  const r = await fetchJson(url.toString(), { timeoutMs: 9000 });
  if (!r.ok || !r.json) throw new Error("YouTube fetch 실패: " + r.status);

  const titles = (r.json.items || []).map((it) => String(it?.snippet?.title || "")).filter(Boolean);
  const { top, relatedList } = deriveFromTitles(titles, hl, 80);

  const items = top.map(({ term, count }) => {
    const base = Math.max(30, count * 22);
    const series = synthSeries(n, base);
    return {
      term,
      series,
      score: scoreFromSeries(series),
      related: relatedList(term).slice(0, 8),
      links: makeLinks(term, geo, hl),
    };
  });

  return {
    items: topN(items, 20),
    meta: {
      source: "youtube",
      isMock: false,
      seriesIsSynthetic: true,
      note: "YouTube MostPopular 제목 토큰 빈도 기반 근사",
      fetchedAt: nowIso(),
    },
  };
}

/* -----------------------
 * Google Trends realtime RSS
 * ---------------------- */
async function fromGoogleTrendsRss({ tf, geo, hl, cat }) {
  const n = bucketCount(tf);
  const category = cat && cat !== "all" ? cat : "all";
  const url = `https://trends.google.com/trends/trendingsearches/realtime/rss?geo=${encodeURIComponent(geo)}&category=${encodeURIComponent(category)}`;

  const r = await fetchText(url, { timeoutMs: 9000, headers: { "User-Agent": "trends-proxy/1.0" } });
  if (!r.ok || !r.text) throw new Error("Google Trends RSS fetch 실패: " + r.status);

  const terms = parseFeedTitles(r.text).slice(0, 60);
  if (terms.length < 3) {
    return makeMock(tf, geo, hl, { source: "googleTrends", note: "trends rss 파싱 실패 → mock", isMock: true });
  }

  const items = terms.map((term, idx) => {
    const base = Math.max(30, 220 - idx * 3 + Math.floor(Math.random() * 20));
    const series = synthSeries(n, base);
    return {
      term,
      series,
      score: scoreFromSeries(series),
      related: [term + " 뜻", term + " 이슈", term + " 뉴스", term + " 실시간"].slice(0, 4),
      links: makeLinks(term, geo, hl),
    };
  });

  return {
    items: topN(items, 20),
    meta: {
      source: "googleTrends",
      isMock: false,
      seriesIsSynthetic: true,
      note: "Google Trends realtime RSS 기반 (시계열은 근사 생성)",
      fetchedAt: nowIso(),
    },
  };
}

/* -----------------------
 * Google News RSS (Top stories)
 * ---------------------- */
async function fromGoogleNewsRss({ tf, geo, hl }) {
  const n = bucketCount(tf);

  const ceid = `${geo}:${hl}`;
  const url = `https://news.google.com/rss?hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(geo)}&ceid=${encodeURIComponent(ceid)}`;

  const r = await fetchText(url, { timeoutMs: 9000, headers: { "User-Agent": "trends-proxy/1.0" } });
  if (!r.ok || !r.text) throw new Error("Google News RSS fetch 실패: " + r.status);

  const titlesRaw = parseFeedTitles(r.text).slice(0, 120);
  const titles = titlesRaw.map((t) => String(t).split(" - ")[0]);

  const { top, relatedList } = deriveFromTitles(titles, hl, 80);

  const items = top.map(({ term, count }) => {
    const base = Math.max(30, count * 25);
    const series = synthSeries(n, base);
    return {
      term,
      series,
      score: scoreFromSeries(series),
      related: relatedList(term).slice(0, 8),
      links: makeLinks(term, geo, hl),
    };
  });

  return {
    items: topN(items, 20),
    meta: {
      source: "news",
      isMock: false,
      seriesIsSynthetic: true,
      note: "Google News RSS 제목 토큰 빈도 기반 근사",
      fetchedAt: nowIso(),
    },
  };
}

/* -----------------------
 * HackerNews (Algolia)
 * ---------------------- */
async function fromHackerNews({ tf, geo, hl }) {
  const n = bucketCount(tf);
  const r = await fetchJson("https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=80", { timeoutMs: 9000 });
  if (!r.ok || !r.json) throw new Error("HN fetch 실패: " + r.status);

  const titles = (r.json.hits || []).map((h) => String(h?.title || "")).filter(Boolean);
  const { top, relatedList } = deriveFromTitles(titles, "en", 80);

  const items = top.map(({ term, count }) => {
    const base = Math.max(30, count * 20);
    const series = synthSeries(n, base);
    return {
      term,
      series,
      score: scoreFromSeries(series),
      related: relatedList(term).slice(0, 8),
      links: makeLinks(term, geo, hl),
    };
  });

  return {
    items: topN(items, 20),
    meta: {
      source: "hackernews",
      isMock: false,
      seriesIsSynthetic: true,
      note: "HN 제목 토큰 빈도 기반 근사",
      fetchedAt: nowIso(),
    },
  };
}

/* -----------------------
 * Naver DataLab (Discover → Re-rank)
 * - 네이버는 “전체 실시간 TOP키워드 API”가 아니라 “내가 준 키워드들의 트렌드 비교 API”
 * - 그래서 후보키워드는 GoogleTrends/News/YouTube에서 자동 수집하고
 * - 그 후보군을 DataLab로 검증/리랭킹해서 TOP20을 뽑는다
 * ---------------------- */
async function fromNaverDataLabDiscover({ tf, geo, hl, clientId, clientSecret }) {
  const n = bucketCount(tf);

  const maxCandidates = clampInt(process.env.NAVER_CANDIDATES || 35, 10, 60);

  // 후보 키워드 자동 수집
  const candidates = await gatherCandidates({ geo, hl, maxCandidates });

  // (선택) 사용자가 넣은 NAVER_SEEDS가 있으면 후보에 섞어서 안정성 강화
  const seedsEnv = (process.env.NAVER_SEEDS || "").toString().trim();
  const seeds = seedsEnv ? seedsEnv.split(",").map((s) => s.trim()).filter(Boolean) : [];

  const finalCandidates = Array.from(new Set([...candidates, ...seeds])).slice(0, maxCandidates);

  // DataLab은 hour 단위를 직접 지원하지 않음 (date/week/month)
  const timeUnit = tf === "week" ? "week" : tf === "month" ? "month" : "date";
  const { startDate, endDate } = naverDateRange(timeUnit, tf);

  const chunks = chunkArray(finalCandidates, 5);
  const seriesByTerm = new Map();
  const errors = [];

  for (const group of chunks) {
    const body = {
      startDate,
      endDate,
      timeUnit,
      keywordGroups: group.map((kw) => ({ groupName: kw, keywords: [kw] })),
      device: "",
      ages: [],
      gender: "",
    };

    const r = await fetchJson("https://openapi.naver.com/v1/datalab/search", {
      timeoutMs: 9000,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Naver-Client-Id": clientId,
        "X-Naver-Client-Secret": clientSecret,
      },
      body: JSON.stringify(body),
    });

    if (!r.ok || !r.json) {
      errors.push({ chunk: group, status: r.status, text: (r.text || "").slice(0, 200) });
      continue;
    }

    const results = r.json.results || [];
    for (const rs of results) {
      const term = String(rs.title || rs.keyword || "").trim();
      const raw = (rs.data || []).map((d) => Number(d.ratio || 0));
      if (!term || raw.length === 0) continue;

      let series;
      if (tf === "hour") {
        // hour는 제공 불가 → 최근 흐름 기반 24버킷 근사(보기용)
        const base = raw[raw.length - 1] || 10;
        series = synthSeries(n, Math.max(10, Math.round(base * 10)));
      } else {
        // date/week/month는 리샘플해서 n개로 맞춤 + 스케일
        series = resampleToN(raw, n).map((v) => Math.round(v * 10));
      }

      seriesByTerm.set(term, series);
    }
  }

  if (seriesByTerm.size < 5) {
    return makeMock(tf, geo, hl, {
      source: "naver",
      note: "Naver DataLab 결과 부족/실패 → mock",
      isMock: true,
      debug: { errors, startDate, endDate, timeUnit, candidatesPreview: finalCandidates.slice(0, 25) },
    });
  }

  // 리랭킹: 현재값 + 최근 평균 대비 가속도
  const items = [];
  for (const [term, series] of seriesByTerm.entries()) {
    const last = series[series.length - 1] || 0;
    const prev = series.slice(Math.max(0, series.length - 4), series.length - 1);
    const prevAvg = prev.length ? prev.reduce((a, b) => a + b, 0) / prev.length : 0;
    const momentum = (last - prevAvg) / (prevAvg + 1);

    const score = Math.round(last + momentum * 1200);

    items.push({
      term,
      series,
      score,
      related: [term + " 검색", term + " 트렌드", term + " 뉴스", term + " 이슈"].slice(0, 4),
      links: makeLinks(term, geo, hl),
    });
  }

  return {
    items: topN(items, 20),
    meta: {
      source: "naver",
      isMock: false,
      seriesIsSynthetic: true,
      note: "후보 자동 수집(Trends/News/YouTube) → Naver DataLab 가속도 리랭킹 TOP20",
      fetchedAt: nowIso(),
      debug: {
        startDate,
        endDate,
        timeUnit,
        candidateCount: finalCandidates.length,
        candidatesPreview: finalCandidates.slice(0, 25),
        errors: errors.length ? errors : undefined,
      },
    },
  };
}

async function gatherCandidates({ geo, hl, maxCandidates }) {
  const out = [];
  const add = (t) => {
    const term = String(t || "").trim();
    if (!isGoodCandidate(term, hl)) return;
    out.push(term);
  };

  // 1) Google Trends Realtime RSS terms
  try {
    const url = `https://trends.google.com/trends/trendingsearches/realtime/rss?geo=${encodeURIComponent(geo)}&category=all`;
    const r = await fetchText(url, { timeoutMs: 9000, headers: { "User-Agent": "trends-proxy/1.0" } });
    if (r.ok && r.text) {
      const terms = parseFeedTitles(r.text).slice(0, 60);
      for (const t of terms) add(t);
    }
  } catch {}

  // 2) Google News RSS tokens (제목에서 토큰 추출)
  try {
    const ceid = `${geo}:${hl}`;
    const url = `https://news.google.com/rss?hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(geo)}&ceid=${encodeURIComponent(ceid)}`;
    const r = await fetchText(url, { timeoutMs: 9000, headers: { "User-Agent": "trends-proxy/1.0" } });
    if (r.ok && r.text) {
      const titlesRaw = parseFeedTitles(r.text).slice(0, 120).map((t) => String(t).split(" - ")[0]);
      const { top } = deriveFromTitles(titlesRaw, hl, 60);
      for (const x of top) add(x.term);
    }
  } catch {}

  // 3) YouTube MostPopular tokens (키가 있으면)
  try {
    const key = process.env.YT_KEY || process.env.YOUTUBE_API_KEY;
    if (key) {
      const url = new URL("https://www.googleapis.com/youtube/v3/videos");
      url.searchParams.set("part", "snippet");
      url.searchParams.set("chart", "mostPopular");
      url.searchParams.set("maxResults", "50");
      url.searchParams.set("regionCode", geo || "KR");
      url.searchParams.set("key", key);

      const r = await fetchJson(url.toString(), { timeoutMs: 9000 });
      if (r.ok && r.json?.items?.length) {
        const titles = r.json.items.map((it) => String(it?.snippet?.title || "")).filter(Boolean);
        const { top } = deriveFromTitles(titles, hl, 60);
        for (const x of top) add(x.term);
      }
    }
  } catch {}

  const uniq = Array.from(new Set(out));
  return uniq.slice(0, maxCandidates);
}

function isGoodCandidate(term, hl) {
  if (!term) return false;
  if (term.length < 2) return false;
  if (/^\d+$/.test(term)) return false;

  // 너무 흔한 단어 제거(간단)
  const ban = new Set([
    "today","live","official","news","update",
    "영상","뉴스","속보","공식","하이라이트","티저","리뷰","반응",
  ]);
  if (ban.has(term.toLowerCase())) return false;

  // 한국어 우선 모드: 한글 포함을 강하게 우대
  if (hl === "ko") {
    if (!/[가-힣]/.test(term)) return false;
  }
  return true;
}

/* -----------------------
 * Naver Date helpers + resample
 * ---------------------- */
function naverDateRange(timeUnit, tf) {
  const end = new Date();
  const endDate = toYmd(end);

  const start = new Date(end);
  if (timeUnit === "date") {
    // day/hour 모두 최소 7일 확보
    start.setDate(start.getDate() - 6);
  } else if (timeUnit === "week") {
    start.setDate(start.getDate() - (8 * 7 - 1));
  } else {
    start.setMonth(start.getMonth() - 11);
  }

  return { startDate: toYmd(start), endDate };
}
function toYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
function resampleToN(arr, n) {
  const a = Array.isArray(arr) ? arr : [];
  if (a.length === 0) return Array.from({ length: n }, () => 0);
  if (a.length === 1) return Array.from({ length: n }, () => a[0]);

  const out = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1 || 1);
    const idx = t * (a.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.min(a.length - 1, lo + 1);
    const w = idx - lo;
    const v = a[lo] * (1 - w) + a[hi] * w;
    out.push(Number.isFinite(v) ? v : 0);
  }
  return out;
}
