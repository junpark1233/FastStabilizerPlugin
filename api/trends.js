// /api/trends.js
// Vercel Serverless Function (ESM)
// - 여러 소스(YouTube / Naver DataLab / Reddit / Google Trends RSS / Google News RSS / HackerNews / Mock)
// - CORS + 캐시 + 실패 시 stale 캐시/Mock로 graceful fallback
//
// Query params (dashboard 호환):
//   source: mock | youtube | naver | reddit | googleTrends | news | hackernews
//   tf: hour | day | week | month
//   geo: KR, US ...
//   hl: ko, en ...
//   cat: (optional)
//   q: (optional) 서버측 1차 필터
//
// Env:
//   YOUTUBE_API_KEY (or YT_KEY)
//   NAVER_CLIENT_ID
//   NAVER_CLIENT_SECRET
//   NAVER_SEEDS (comma separated)  예: "테슬라,비트코인,다이어트,연애,ETF,..."
//   REDDIT_SUBS (comma separated)  예: "worldnews,technology,programming,korea"

export default async function handler(req, res) {
  // --- CORS ---
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  // --- CDN Cache ---
  // 60초 CDN 캐시, 최대 5분 stale 허용 (개인용 호출수 절감)
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");

  const startedAt = Date.now();

  try {
    const sourceRaw = (req.query.source ?? "mock").toString();
    const source = normalizeSource(sourceRaw);

    const tf = normalizeTf((req.query.tf ?? req.query.timeframe ?? "hour").toString());
    const geo = ((req.query.geo ?? req.query.country ?? "KR") || "KR").toString().toUpperCase();
    const hl = ((req.query.hl ?? req.query.lang ?? "ko") || "ko").toString().toLowerCase();
    const cat = ((req.query.cat ?? "all") || "all").toString();
    const q = ((req.query.q ?? "") || "").toString();

    const cacheKey = JSON.stringify({ source, tf, geo, hl, cat, q });
    const cachedFresh = memGet(cacheKey, 45_000); // 45초 in-memory 캐시
    if (cachedFresh) return res.status(200).json(cachedFresh);

    let payload;

    // 실제 호출 실패 시 stale라도 반환하도록 "마지막 성공 캐시"도 따로 유지
    const cachedStale = memGetAny(cacheKey); // TTL 무시

    try {
      if (source === "mock") {
        payload = makeMock(tf, geo, hl, { note: "mock", isMock: true });

      } else if (source === "youtube") {
        const key = process.env.YOUTUBE_API_KEY || process.env.YT_KEY;
        if (!key) {
          payload = makeMock(tf, geo, hl, { note: "YOUTUBE_API_KEY 없음 → mock", isMock: true });
        } else {
          payload = await fromYouTubeMostPopular({ tf, geo, hl, key });
        }

      } else if (source === "naver") {
        const id = process.env.NAVER_CLIENT_ID;
        const secret = process.env.NAVER_CLIENT_SECRET;
        if (!id || !secret) {
          payload = makeMock(tf, geo, hl, { note: "NAVER_CLIENT_ID/SECRET 없음 → mock", isMock: true });
        } else {
          payload = await fromNaverDataLab({ tf, geo, hl, clientId: id, clientSecret: secret });
        }

      } else if (source === "reddit") {
        payload = await fromReddit({ tf, geo, hl });

      } else if (source === "googleTrends") {
        payload = await fromGoogleTrendsRss({ tf, geo, hl, cat });

      } else if (source === "news") {
        payload = await fromGoogleNewsRss({ tf, geo, hl });

      } else if (source === "hackernews") {
        payload = await fromHackerNews({ tf, geo, hl });

      } else {
        payload = makeMock(tf, geo, hl, { note: `unknown source(${sourceRaw}) → mock`, isMock: true });
      }
    } catch (fetchErr) {
      // 소스 호출 실패 → stale 캐시가 있으면 stale로, 없으면 mock
      if (cachedStale) {
        payload = {
          ...cachedStale,
          meta: {
            ...(cachedStale.meta || {}),
            stale: true,
            staleReason: fetchErr?.message || String(fetchErr),
          },
        };
      } else {
        payload = makeMock(tf, geo, hl, { note: `fetch fail → mock: ${fetchErr?.message || fetchErr}`, isMock: true });
      }
    }

    // q(검색어) 서버 1차 필터
    if (q && payload?.items?.length) {
      const qq = q.toLowerCase();
      payload.items = payload.items.filter((x) => String(x.term || "").toLowerCase().includes(qq));
      // rank 재부여
      payload.items.forEach((x, i) => (x.rank = i + 1));
    }

    payload.meta = payload.meta || {};
    payload.meta.tookMs = Date.now() - startedAt;

    // 캐시 저장
    memSet(cacheKey, payload);        // fresh
    memSetAny(cacheKey, payload);     // stale용 마지막 성공/마지막 결과

    return res.status(200).json(payload);
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
}

/* -----------------------
 * Cache (serverless 약한 캐시)
 * ---------------------- */
function memMap() {
  globalThis.__TRENDS_CACHE__ ||= new Map();
  return globalThis.__TRENDS_CACHE__;
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
  // ts를 아주 오래 유지하고 싶으면 별도 맵이 낫지만, 단순히 latest 보관으로 충분
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

/* -----------------------
 * Common helpers
 * ---------------------- */
function nowIso() {
  return new Date().toISOString();
}
function makeLinks(term, geo, hl) {
  return {
    google: "https://www.google.com/search?q=" + encodeURIComponent(term),
    youtube: "https://www.youtube.com/results?search_query=" + encodeURIComponent(term),
    news: "https://news.google.com/search?q=" + encodeURIComponent(term) + `&hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(geo)}`,
  };
}
function clampInt(n, min, max) {
  const x = Number.isFinite(+n) ? +n : 0;
  return Math.min(max, Math.max(min, x));
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
  if (!Array.isArray(series) || series.length === 0) return 0;
  const last = series[series.length - 1] || 0;
  const prev = series[Math.max(0, series.length - 2)] || 0;
  const delta = last - prev;
  // last + momentum 약간
  return Math.round(last + delta * 0.6);
}
function topNItems(items, n = 20) {
  const arr = Array.isArray(items) ? items.slice() : [];
  arr.sort((a, b) => (b.score || 0) - (a.score || 0));
  return arr.slice(0, n).map((x, i) => ({ ...x, rank: i + 1 }));
}
function safeJson(x) {
  try { return JSON.stringify(x); } catch { return String(x); }
}

/* -----------------------
 * Tokenizer (간단형)
 * ---------------------- */
function buildStopwords(hl) {
  const baseEn = [
    "the","a","an","and","or","to","of","in","on","for","with","is","are","was","were","be","from",
    "vs","ver","feat","official","mv","teaser","trailer","full","live","episode","ep","part",
  ];
  const baseKo = [
    "영상","공식","라이브","뮤비","예고","티저","하이라이트","리뷰","반응","요약","뉴스","속보","단독",
    "오늘","지금","최신","화제","사건","사고","인터뷰","출연","공개","발표",
  ];
  const set = new Set();
  for (const w of baseEn) set.add(w);
  for (const w of baseKo) set.add(w);
  // 언어별 추가 가능
  return set;
}
function tokenize(text, stopSet) {
  const t = String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return [];
  const toks = t.split(" ").filter(Boolean);
  const out = [];
  for (const tok of toks) {
    if (tok.length < 2) continue;
    if (stopSet.has(tok)) continue;
    out.push(tok);
  }
  return out;
}
function freqFromTitles(titles, hl) {
  const stop = buildStopwords(hl);
  const freq = new Map();
  for (const title of titles) {
    const toks = tokenize(title, stop);
    for (const tk of toks) freq.set(tk, (freq.get(tk) || 0) + 1);
  }
  return freq;
}

/* -----------------------
 * RSS/Atom parsing (레딧/뉴스/트렌드 공용)
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

// RSS (<item><title>) + Atom (<entry><title>) 둘 다 지원
function parseFeedTitles(xmlText) {
  if (!xmlText || typeof xmlText !== "string") return [];
  const titles = [];

  const pushTitle = (raw) => {
    const t = stripHtml(decodeXml(raw)).trim();
    if (t && t.length >= 2) titles.push(t);
  };

  // RSS
  const rssRe = /<item[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<\/item>/gi;
  let m;
  while ((m = rssRe.exec(xmlText)) !== null) pushTitle(m[1]);

  // Atom
  const atomRe = /<entry[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>[\s\S]*?<\/entry>/gi;
  while ((m = atomRe.exec(xmlText)) !== null) pushTitle(m[1]);

  return Array.from(new Set(titles));
}

/* -----------------------
 * Fetch helpers (timeout)
 * ---------------------- */
async function fetchText(url, opts = {}) {
  const timeoutMs = clampInt(opts.timeoutMs ?? 8000, 1000, 20000);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: controller.signal });
    const txt = await r.text();
    return { ok: r.ok, status: r.status, text: txt, headers: r.headers };
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
    items: topNItems(items, 20),
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
 * YouTube (MostPopular -> 제목 토큰 빈도 기반 근사)
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
  const freq = freqFromTitles(titles, hl);

  // 상위 단어들을 키워드로 사용
  const sorted = Array.from(freq.entries()).sort((a, b) => b[1] - a[1]).slice(0, 80);

  const items = sorted.map(([term, count]) => {
    const base = count * 22;
    const series = synthSeries(n, base);
    return {
      term,
      series,
      score: scoreFromSeries(series),
      related: [term + " reaction", term + " review", term + " highlights", term + " news"].slice(0, 4),
      links: makeLinks(term, geo, hl),
    };
  });

  return {
    items: topNItems(items, 20),
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
 * Reddit (JSON 우선, 막히면 RSS/Atom fallback)
 * ---------------------- */
async function fromReddit({ tf, geo, hl }) {
  const n = bucketCount(tf);
  const subsEnv = (process.env.REDDIT_SUBS || "worldnews,technology,programming,korea").toString();
  const subs = subsEnv.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 12);

  const titles = [];
  const errors = [];

  // ✅ RSS/Atom만 사용 (403 noisy 제거 + 더 안정적)
  for (const sub of subs) {
    const rssUrl = `https://www.reddit.com/r/${encodeURIComponent(sub)}/hot.rss`;
    const r = await fetchText(rssUrl, {
      timeoutMs: 8000,
      headers: {
        "User-Agent": "trends-proxy/1.0 (personal use)",
        "Accept": "application/rss+xml, application/atom+xml, text/xml;q=0.9, */*;q=0.8",
      },
    });

    if (r.ok && r.text) {
      const feedTitles = parseFeedTitles(r.text);
      for (const t of feedTitles) titles.push(String(t));
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

  const freq = freqFromTitles(titles, hl);
  const sorted = Array.from(freq.entries()).sort((a, b) => b[1] - a[1]).slice(0, 80);

  const items = sorted.map(([term, count]) => {
    const base = count * 18;
    const series = synthSeries(n, base);
    return {
      term,
      series,
      score: scoreFromSeries(series),
      related: [term + " reddit", term + " news", term + " discussion", term + " analysis"].slice(0, 4),
      links: makeLinks(term, geo, hl),
    };
  });

  return {
    items: topNItems(items, 20),
    meta: {
      source: "reddit",
      isMock: false,
      seriesIsSynthetic: true,
      note: "Reddit hot RSS/Atom 제목 토큰 빈도 기반 근사",
      fetchedAt: nowIso(),
      debug: errors?.length ? { errors } : undefined,
    },
  };
}


  // 2) JSON이 거의 다 막혔으면 RSS/Atom fallback
  if (titles.length < 10) {
    for (const sub of subs) {
      const rssUrl = `https://www.reddit.com/r/${encodeURIComponent(sub)}/hot.rss`;
      const r = await fetchText(rssUrl, {
        timeoutMs: 8000,
        headers: {
          "User-Agent": "trends-proxy/1.0 (personal use)",
          "Accept": "application/rss+xml, application/atom+xml, text/xml;q=0.9, */*;q=0.8",
        },
      });
      if (r.ok && r.text) {
        const feedTitles = parseFeedTitles(r.text);
        for (const t of feedTitles) titles.push(String(t));
      } else {
        errors.push({ sub, rssStatus: r.status });
      }
    }
  }

  // 여전히 데이터가 없으면 mock
  if (titles.length < 5) {
    return makeMock(tf, geo, hl, {
      source: "reddit",
      note: "reddit fetch 결과 0~소량 → mock fallback (레이트리밋/차단 가능)",
      isMock: true,
      debug: { errors },
    });
  }

  const freq = freqFromTitles(titles, hl);
  const sorted = Array.from(freq.entries()).sort((a, b) => b[1] - a[1]).slice(0, 80);

  const items = sorted.map(([term, count]) => {
    const base = count * 18;
    const series = synthSeries(n, base);
    return {
      term,
      series,
      score: scoreFromSeries(series),
      related: [term + " reddit", term + " news", term + " discussion", term + " analysis"].slice(0, 4),
      links: makeLinks(term, geo, hl),
    };
  });

  return {
    items: topNItems(items, 20),
    meta: {
      source: "reddit",
      isMock: false,
      seriesIsSynthetic: true,
      note: "Reddit hot 제목 토큰 빈도 기반 근사 (JSON 우선, RSS fallback)",
      fetchedAt: nowIso(),
      debug: errors?.length ? { errors } : undefined,
    },
  };
}

/* -----------------------
 * Google Trends RSS (공식 API는 없지만 RSS는 안정적)
 * ---------------------- */
async function fromGoogleTrendsRss({ tf, geo, hl, cat }) {
  const n = bucketCount(tf);

  // realtime trending searches RSS
  // category: all, b, e, m ... 등 트렌드 카테고리 값이 있을 수 있으나 일단 cat 그대로 전달
  const category = cat && cat !== "all" ? cat : "all";
  const url = `https://trends.google.com/trends/trendingsearches/realtime/rss?geo=${encodeURIComponent(geo)}&category=${encodeURIComponent(category)}`;

  const r = await fetchText(url, {
    timeoutMs: 9000,
    headers: { "User-Agent": "trends-proxy/1.0 (personal use)" },
  });
  if (!r.ok || !r.text) throw new Error("Google Trends RSS fetch 실패: " + r.status);

  // 여기서는 feed item title이 곧 "트렌딩 검색어"인 경우가 많음
  const terms = parseFeedTitles(r.text).slice(0, 50);

  if (terms.length < 3) {
    return makeMock(tf, geo, hl, { source: "googleTrends", note: "trends rss 파싱 실패 → mock", isMock: true });
  }

  const items = terms.map((term, idx) => {
    // 순위가 앞일수록 base를 조금 높게
    const base = 220 - idx * 3 + Math.floor(Math.random() * 20);
    const series = synthSeries(n, Math.max(30, base));
    return {
      term,
      series,
      score: scoreFromSeries(series),
      related: [term + " 뜻", term + " 이슈", term + " 뉴스", term + " 실시간"].slice(0, 4),
      links: makeLinks(term, geo, hl),
    };
  });

  return {
    items: topNItems(items, 20),
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
 * Google News RSS (Top stories 제목 토큰 빈도 기반 근사)
 * ---------------------- */
async function fromGoogleNewsRss({ tf, geo, hl }) {
  const n = bucketCount(tf);

  // Google News Top Stories RSS
  // ceid 포맷: ${geo}:${hl} (예: KR:ko, US:en)
  const ceid = `${geo}:${hl}`;
  const url = `https://news.google.com/rss?hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(geo)}&ceid=${encodeURIComponent(ceid)}`;

  const r = await fetchText(url, {
    timeoutMs: 9000,
    headers: { "User-Agent": "trends-proxy/1.0 (personal use)" },
  });
  if (!r.ok || !r.text) throw new Error("Google News RSS fetch 실패: " + r.status);

  const titlesRaw = parseFeedTitles(r.text);
  // "제목 - 언론사" 형태가 많아서 뒤쪽 정리
  const titles = titlesRaw.map((t) => String(t).split(" - ").slice(0, 1).join(" - "));

  const freq = freqFromTitles(titles, hl);
  const sorted = Array.from(freq.entries()).sort((a, b) => b[1] - a[1]).slice(0, 80);

  const items = sorted.map(([term, count]) => {
    const base = count * 25;
    const series = synthSeries(n, base);
    return {
      term,
      series,
      score: scoreFromSeries(series),
      related: [term + " 속보", term + " 전망", term + " 이슈", term + " 뉴스"].slice(0, 4),
      links: makeLinks(term, geo, hl),
    };
  });

  return {
    items: topNItems(items, 20),
    meta: {
      source: "news",
      isMock: false,
      seriesIsSynthetic: true,
      note: "Google News RSS Top stories 제목 토큰 빈도 기반 근사",
      fetchedAt: nowIso(),
    },
  };
}

/* -----------------------
 * HackerNews (Algolia) - 무료/키 불필요
 * ---------------------- */
async function fromHackerNews({ tf, geo, hl }) {
  const n = bucketCount(tf);
  const r = await fetchJson("https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=80", { timeoutMs: 9000 });
  if (!r.ok || !r.json) throw new Error("HN fetch 실패: " + r.status);

  const titles = (r.json.hits || []).map((h) => String(h?.title || "")).filter(Boolean);
  const freq = freqFromTitles(titles, "en"); // HN은 영어 토큰이 유리

  const sorted = Array.from(freq.entries()).sort((a, b) => b[1] - a[1]).slice(0, 80);
  const items = sorted.map(([term, count]) => {
    const base = count * 20;
    const series = synthSeries(n, base);
    return {
      term,
      series,
      score: scoreFromSeries(series),
      related: [term + " ai", term + " open-source", term + " startup", term + " security"].slice(0, 4),
      links: makeLinks(term, geo, hl),
    };
  });

  return {
    items: topNItems(items, 20),
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
 * Naver DataLab Search API
 * - '전체 실시간 TOP' 제공이 아니라, "내가 준 후보 키워드(NAVER_SEEDS)"의 트렌드만 조회 가능
 * - 그래서 후보군에서 스코어링해서 TOP20을 만든다
 * ---------------------- */
async function fromNaverDataLab({ tf, geo, hl, clientId, clientSecret }) {
  const n = bucketCount(tf);

  // 후보 키워드(Seeds)
  const seedsEnv = (process.env.NAVER_SEEDS || "").toString().trim();
  let seeds = seedsEnv
    ? seedsEnv.split(",").map((s) => s.trim()).filter(Boolean)
    : [
        "테슬라","비트코인","엔비디아","나스닥","ETF",
        "부동산","다이어트","여행","아이폰","AI",
        "코스피","환율","금리","전기차","반도체",
        "쇼츠","유튜브","연애","월급","취업",
      ];

  // 너무 길면 60개까지만 (호출비용/속도)
  seeds = seeds.slice(0, 60);

  // Naver DataLab timeUnit: date / week / month (hour 없음)
  // hour는 date로 조회한 뒤 24버킷은 근사 생성
  const timeUnit = tf === "week" ? "week" : tf === "month" ? "month" : "date";

  const { startDate, endDate } = naverDateRange(timeUnit, tf);

  // DataLab은 한번에 keywordGroups 개수 제한이 있을 수 있어서 chunk(기본 5)
  const chunks = chunkArray(seeds, 5);

  const seriesByTerm = new Map();
  const errors = [];

  for (const group of chunks) {
    const body = {
      startDate,
      endDate,
      timeUnit,
      keywordGroups: group.map((kw) => ({ groupName: kw, keywords: [kw] })),
      device: "",  // all
      ages: [],    // all
      gender: "",  // all
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
      errors.push({ chunk: group, status: r.status, text: r.text?.slice(0, 200) });
      continue;
    }

    // result: [{ title, keyword, data:[{period,ratio},...] }]
    const results = r.json.results || [];
    for (const rs of results) {
      const term = String(rs.title || rs.keyword || "").trim();
      const dataArr = (rs.data || []).map((d) => Number(d.ratio || 0));
      if (!term) continue;

      let series;

      if (tf === "hour") {
        // date 단위의 마지막 값(또는 최근 2개)으로 24시간 근사 생성
        const base = dataArr.length ? dataArr[dataArr.length - 1] : 10;
        series = synthSeries(n, Math.max(10, Math.round(base * 10)));
      } else {
        // date/week/month 결과 길이가 n과 다를 수 있어 리샘플(간단)
        series = resampleToN(dataArr, n);
        // 값이 너무 작으면 가독성 위해 스케일 업(비율이라 0~100)
        series = series.map((v) => Math.round(v * 10));
      }

      seriesByTerm.set(term, series);
    }
  }

  if (seriesByTerm.size < 5) {
    return makeMock(tf, geo, hl, {
      source: "naver",
      note: "Naver DataLab 결과 부족/실패 → mock",
      isMock: true,
      debug: { errors, startDate, endDate, timeUnit },
    });
  }

  const items = [];
  for (const [term, series] of seriesByTerm.entries()) {
    const score = scoreFromSeries(series);
    items.push({
      term,
      series,
      score,
      related: [term + " 검색", term + " 트렌드", term + " 뉴스", term + " 뜻"].slice(0, 4),
      links: makeLinks(term, geo, hl),
    });
  }

  return {
    items: topNItems(items, 20),
    meta: {
      source: "naver",
      isMock: false,
      seriesIsSynthetic: true,
      note: "Naver DataLab(후보 키워드 기반) — 시계열은 리샘플/근사 포함",
      fetchedAt: nowIso(),
      debug: errors?.length ? { errors, startDate, endDate, timeUnit } : { startDate, endDate, timeUnit },
    },
  };
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Naver timeUnit별 날짜 범위
function naverDateRange(timeUnit, tf) {
  const end = new Date(); // today
  const endDate = toYmd(end);

  let start = new Date(end);
  if (timeUnit === "date") {
    // 최소 7일 정도 확보 (hour도 date 조회)
    const days = tf === "day" ? 7 : 7;
    start.setDate(start.getDate() - (days - 1));
  } else if (timeUnit === "week") {
    // 8주 정도
    start.setDate(start.getDate() - (8 * 7 - 1));
  } else {
    // month: 12개월 정도
    start.setMonth(start.getMonth() - 11);
  }

  const startDate = toYmd(start);
  return { startDate, endDate };
}

function toYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// 길이가 들쭉날쭉한 배열을 n개로 리샘플(간단 선형)
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
