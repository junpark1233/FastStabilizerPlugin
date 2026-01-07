// Vercel Serverless Function: /api/trends
// 개인용/무료 범위 전제: CDN 캐시 + 메모리 캐시로 호출 최소화
export default async function handler(req, res) {
  // --- CORS ---
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  // --- CDN 캐시 (무료 플랜 유지에 도움) ---
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");

  try {
    const {
      source = "mock",
      timeframe = "hour",
      country = "KR",
      lang = "ko",
      cat = "all",
      q = ""
    } = req.query;

    // --- 메모리 캐시 (서버리스라 약하지만 동일 인스턴스 내에선 매우 효과적) ---
    const cacheKey = JSON.stringify({ source, timeframe, country, lang, cat, q });
    const cached = memoryCacheGet(cacheKey, 30_000); // 30초
    if (cached) return res.status(200).json(cached);

    let payload;

    // ✅ 대시보드에서 선택하는 프록시 소스들이 "무조건 응답"하도록 구성
    if (source === "mock") {
      payload = makeMock(timeframe, { note: "proxy mock" });

    } else if (source === "hackernews") {
      payload = await fromHackerNews(timeframe);

    } else if (source === "youtube") {
      // YouTube는 프론트 직결도 가능하지만 키 노출 싫으면 프록시 권장
      const key = process.env.YT_KEY; // Vercel 환경변수
      if (!key) {
        payload = makeMock(timeframe, { note: "YT_KEY 환경변수가 없어 mock로 대체", approx: true });
      } else {
        payload = await fromYouTubeMostPopular(timeframe, country, key);
      }

    // ✅ 추가: 대시보드에서 프록시 소스로 자주 쓰는 값들
    // (실데이터 붙이기 전에도 UI가 바로 동작하도록 mock으로라도 응답)
    } else if (source === "googleTrends" || source === "naverDataLab" || source === "redditNews") {
      payload = makeMock(timeframe, { note: `${source}는 현재 데모(mock)로 동작`, approx: true });

    } else {
      // 알 수 없는 source라도 UX 위해 mock으로 graceful fallback
      payload = makeMock(timeframe, { note: `unknown source(${source}) → mock fallback`, approx: true });
    }

    // q(검색어) 1차 필터
    if (q && payload?.items?.length) {
      const qq = String(q).toLowerCase();
      payload.items = payload.items.filter(x => String(x.term || "").toLowerCase().includes(qq));
    }

    memoryCacheSet(cacheKey, payload);
    return res.status(200).json(payload);

  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
}

/* -----------------------------
   Memory cache
------------------------------ */
function memoryCacheGet(key, ttlMs) {
  globalThis.__CACHE__ ||= new Map();
  const v = globalThis.__CACHE__.get(key);
  if (!v) return null;
  if (Date.now() - v.ts > ttlMs) return null;
  return v.data;
}
function memoryCacheSet(key, data) {
  globalThis.__CACHE__ ||= new Map();
  globalThis.__CACHE__.set(key, { ts: Date.now(), data });
}

/* -----------------------------
   Buckets
------------------------------ */
function bucketCount(timeframe) {
  if (timeframe === "hour") return 24;
  if (timeframe === "day") return 7;
  if (timeframe === "week") return 8;
  if (timeframe === "month") return 12;
  return 24;
}

/* -----------------------------
   Mock generator
------------------------------ */
function makeMock(timeframe, metaExtra = {}) {
  const n = bucketCount(timeframe);
  const terms = [
    "테슬라","비트코인","AI","아이폰","금리","환율","유튜브","넷플릭스","엔비디아","나스닥",
    "코스피","부동산","다이어트","여행","반도체","전기차","CPI","FOMC","ETF","코인"
  ];

  const items = terms.map((t) => {
    const base = 50 + Math.floor(Math.random() * 120);
    const series = Array.from({ length: n }, (_, k) => {
      const trend = 0.7 + 0.6 * (k / (n - 1 || 1));
      const noise = 0.85 + Math.random() * 0.3;
      return Math.max(0, Math.round(base * trend * noise));
    });
    return {
      term: t,
      series,
      related: [t + " 전망", t + " 뉴스", t + " 분석", t + " 가격"].slice(0, 4),
      links: {
        google: "https://www.google.com/search?q=" + encodeURIComponent(t),
        youtube: "https://www.youtube.com/results?search_query=" + encodeURIComponent(t),
        news: "https://news.google.com/search?q=" + encodeURIComponent(t)
      }
    };
  });

  return { items, meta: { approx: true, ...metaExtra } };
}

/* -----------------------------
   HackerNews (Algolia) - 무료/키 불필요
------------------------------ */
async function fromHackerNews(timeframe) {
  const n = bucketCount(timeframe);
  const r = await fetch("https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=50");
  if (!r.ok) throw new Error("HN fetch 실패: " + r.status);
  const j = await r.json();

  const stop = new Set(["the","a","an","and","or","to","of","in","on","for","with","is","are","this","that","you","your","how","why","what"]);
  const freq = new Map();

  for (const hit of (j.hits || [])) {
    const title = String(hit.title || "").toLowerCase();
    const tokens = title
      .replace(/[^\p{L}\p{N}\s]+/gu, " ")
      .split(/\s+/).filter(Boolean)
      .filter(t => t.length >= 3 && !stop.has(t));
    for (const t of tokens) freq.set(t, (freq.get(t) || 0) + 1);
  }

  const sorted = Array.from(freq.entries()).sort((a, b) => b[1] - a[1]).slice(0, 40);

  const items = sorted.map(([term, count]) => {
    const base = count * 18;
    const series = synthSeries(n, base);
    return {
      term,
      series,
      related: [term + " ai", term + " open-source", term + " startup", term + " security"].slice(0, 4),
      links: {
        google: "https://www.google.com/search?q=" + encodeURIComponent(term),
        youtube: "https://www.youtube.com/results?search_query=" + encodeURIComponent(term),
        news: "https://news.google.com/search?q=" + encodeURIComponent(term)
      }
    };
  });

  return { items, meta: { approx: true, note: "HN 제목 기반 키워드 근사" } };
}

/* -----------------------------
   YouTube MostPopular - 키 필요
------------------------------ */
async function fromYouTubeMostPopular(timeframe, country, key) {
  const n = bucketCount(timeframe);
  const regionCode = country || "KR";

  const url = new URL("https://www.googleapis.com/youtube/v3/videos");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("chart", "mostPopular");
  url.searchParams.set("maxResults", "50");
  url.searchParams.set("regionCode", regionCode);
  url.searchParams.set("key", key);

  const r = await fetch(url.toString());
  if (!r.ok) throw new Error("YouTube fetch 실패: " + r.status);
  const j = await r.json();

  const stop = new Set([
    "the","a","an","and","or","to","of","in","on","for","with","is","are","vs","ver","feat","official","mv",
    "teaser","trailer","full","live","episode","ep","part","영상","공식","라이브","뮤비","예고","티저"
  ]);

  const freq = new Map();
  for (const it of (j.items || [])) {
    const title = String(it.snippet?.title || "").toLowerCase();
    const tokens = title
      .replace(/[^\p{L}\p{N}\s]+/gu, " ")
      .split(/\s+/).filter(Boolean)
      .filter(t => t.length >= 2 && !stop.has(t));
    for (const t of tokens) freq.set(t, (freq.get(t) || 0) + 1);
  }

  const sorted = Array.from(freq.entries()).sort((a, b) => b[1] - a[1]).slice(0, 40);

  const items = sorted.map(([term, count]) => {
    const base = count * 20;
    const series = synthSeries(n, base);
    return {
      term,
      series,
      related: [term + " reaction", term + " review", term + " highlights", term + " news"].slice(0, 4),
      links: {
        google: "https://www.google.com/search?q=" + encodeURIComponent(term),
        youtube: "https://www.youtube.com/results?search_query=" + encodeURIComponent(term),
        news: "https://news.google.com/search?q=" + encodeURIComponent(term)
      }
    };
  });

  return { items, meta: { approx: true, note: "YouTube MostPopular 제목 토큰 빈도로 근사" } };
}

/* -----------------------------
   Series synthesizer
------------------------------ */
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
