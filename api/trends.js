/**
 * api/trends.js  (Vercel Serverless Function - Node.js)
 *
 * 지원 source 값 (대소문자/별칭 자동 처리):
 * - googleTrends
 * - youtube
 * - hackernews
 * - reddit
 * - news
 * - naverDataLab
 * - mock
 *
 * 쿼리:
 * - source: 위 소스명
 * - tf: hour | day | week | month
 * - geo: KR, US ...
 * - hl: ko, en ...
 * - q: (선택) 뉴스/유튜브에서 검색어 기반으로 뽑고 싶을 때
 * - seeds: (선택) naverDataLab에서 후보 키워드 20개를 직접 지정 (comma-separated)
 *
 * 환경변수(Vercel Project Settings → Environment Variables):
 * - YOUTUBE_API_KEY
 * - NAVER_CLIENT_ID
 * - NAVER_CLIENT_SECRET
 * - NAVER_SEEDS (선택, comma-separated)
 * - REDDIT_SUBS (선택, comma-separated)
 */

const CACHE = globalThis.__TRENDS_CACHE__ || (globalThis.__TRENDS_CACHE__ = new Map());

module.exports = async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(204).end();

  const sourceRaw = (req.query.source || "mock").toString();
  const source = normalizeSource(sourceRaw);
  const tf = normalizeTF((req.query.tf || req.query.timeframe || "hour").toString());
  const geo = ((req.query.geo || "KR").toString() || "KR").toUpperCase();
  const hl = (req.query.hl || "ko").toString() || "ko";
  const q = (req.query.q || "").toString().trim();

  const cacheKey = JSON.stringify({
    source,
    tf,
    geo,
    hl,
    q,
    seeds: (req.query.seeds || process.env.NAVER_SEEDS || "").toString(),
  });

  const now = Date.now();
  const ttlMs = getTTL(source, tf);
  const cached = CACHE.get(cacheKey);

  // Fresh cache hit
  if (cached && now - cached.ts < ttlMs) {
    res.setHeader("Cache-Control", `public, s-maxage=${Math.floor(ttlMs / 1000)}, stale-while-revalidate=300`);
    return res.status(200).json(withMeta(cached.data, { cache: "hit", cachedAt: cached.ts }));
  }

  try {
    const provider = getProvider(source);
    const data = await provider({ tf, geo, hl, q, req });

    const final = normalizeResponse(data, { source, tf, geo, hl });
    CACHE.set(cacheKey, { ts: now, data: final });

    res.setHeader("Cache-Control", `public, s-maxage=${Math.floor(ttlMs / 1000)}, stale-while-revalidate=300`);
    return res.status(200).json(withMeta(final, { cache: "miss", cachedAt: now }));
  } catch (err) {
    // stale fallback
    if (cached) {
      return res
        .status(200)
        .json(withMeta(cached.data, { cache: "stale", cachedAt: cached.ts, error: safeErr(err) }));
    }
    // last resort mock
    return res.status(200).json(makeMock({ tf, geo, hl, note: safeErr(err), sourceRequested: sourceRaw }));
  }
};

/* ---------------------------- Provider Router ---------------------------- */

function getProvider(source) {
  const map = {
    googletrends: providerGoogleTrends,
    youtube: providerYouTube,
    hackernews: providerHackerNews,
    reddit: providerReddit,
    news: providerNewsRSS,
    naverdatalab: providerNaverDataLab,
    mock: async ({ tf, geo, hl }) => makeMock({ tf, geo, hl, note: "mock source selected" }),
  };
  return map[source] || map.mock;
}

function normalizeSource(s) {
  const key = (s || "").toString().trim().toLowerCase();
  const alias = {
    "google trends": "googletrends",
    google_trends: "googletrends",
    trends: "googletrends",
    hn: "hackernews",
    hacker_news: "hackernews",
    redditnews: "reddit",
    googlenews: "news",
    naver: "naverdatalab",
    naver_datalab: "naverdatalab",
    datalab: "naverdatalab",
    yt: "youtube",
    youtube_trending: "youtube",
  };
  return alias[key] || key.replace(/\s+/g, "");
}

function normalizeTF(tf) {
  const t = (tf || "hour").toLowerCase();
  if (["hour", "day", "week", "month"].includes(t)) return t;
  return "hour";
}

function getTTL(source, tf) {
  // 개인용 + 쿼터/레이트리밋 보호용: 기본 5분~15분 캐시
  // hour 탭은 조금 더 자주 갱신해도 되지만, 비용/제한 생각해서 5분 권장
  if (source === "googletrends") return 5 * 60 * 1000;
  if (source === "youtube") return 10 * 60 * 1000;
  if (source === "naverdatalab") return 15 * 60 * 1000;
  if (source === "reddit") return 10 * 60 * 1000;
  if (source === "news") return 10 * 60 * 1000;
  if (source === "hackernews") return 10 * 60 * 1000;
  return 5 * 60 * 1000;
}

/* ---------------------------- Google Trends ---------------------------- */

async function providerGoogleTrends({ tf, geo, hl }) {
  // 비공식 엔드포인트 사용. 막히면 캐시/폴백이 중요함.
  const tz = tzFromGeo(geo);
  const url =
    tf === "hour"
      ? `https://trends.google.com/trends/api/realtimetrends?hl=${encodeURIComponent(
          hl
        )}&tz=${encodeURIComponent(tz)}&cat=all&fi=0&fs=0&geo=${encodeURIComponent(
          geo
        )}&ri=300&rs=20&sort=0`
      : `https://trends.google.com/trends/api/dailytrends?hl=${encodeURIComponent(
          hl
        )}&tz=${encodeURIComponent(tz)}&geo=${encodeURIComponent(geo)}&ns=15`;

  const text = await fetchText(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; TrendsProxy/1.0; +https://vercel.app)",
      "Accept-Language": hl,
    },
    timeoutMs: 10000,
  });

  const json = parseGoogleXSSI(text);

  const items = tf === "hour" ? extractRealTimeTrends(json) : extractDailyTrends(json);
  const top = items.slice(0, 20).map((it, idx) => ({
    rank: idx + 1,
    term: it.term,
    score: it.score,
    related: it.related || [],
    series: syntheticSeries(tf, it.term, it.score),
    links: buildLinks(it.term, geo, hl),
  }));

  return {
    items: top,
    meta: {
      source: "googleTrends",
      isMock: false,
      seriesIsSynthetic: true,
      note: "Google Trends는 비공식 엔드포인트 기반. 시계열은 대시보드 로컬 누적으로 ‘실제’가 됨",
    },
  };
}

function parseGoogleXSSI(text) {
  // Google XSSI prefix: )]}'
  const cleaned = text.replace(/^\)\]\}',?\s*\n/, "");
  return JSON.parse(cleaned);
}

function extractRealTimeTrends(j) {
  // 구조가 가끔 바뀌므로 최대한 방어적으로 접근
  const stories =
    j?.storySummaries?.trendingStories ||
    j?.default?.storySummaries?.trendingStories ||
    j?.storySummaries?.trendingStories ||
    [];
  const out = [];
  for (const s of stories) {
    const title = s?.title?.title || s?.title || s?.entityNames?.[0] || "";
    const term = (title || "").toString().trim();
    if (!term) continue;
    const score = Number(s?.formattedTraffic?.replace(/[^\d]/g, "")) || Number(s?.traffic) || 50;
    const related =
      s?.relatedQueries?.map((x) => x?.query).filter(Boolean).slice(0, 8) ||
      s?.entityNames?.slice(0, 8) ||
      [];
    out.push({ term, score: clamp(score, 1, 999), related });
  }
  // score 내림차순
  out.sort((a, b) => b.score - a.score);
  return out;
}

function extractDailyTrends(j) {
  const days =
    j?.default?.trendingSearchesDays ||
    j?.trendingSearchesDays ||
    j?.default?.trendingSearchesDays ||
    [];
  const today = days?.[0]?.trendingSearches || [];
  const out = [];
  for (const t of today) {
    const term = (t?.title?.query || t?.title || "").toString().trim();
    if (!term) continue;
    const traffic = (t?.formattedTraffic || "").toString();
    const score = Number(traffic.replace(/[^\d]/g, "")) || 50;
    const related =
      t?.relatedQueries?.map((x) => x?.query).filter(Boolean).slice(0, 8) ||
      t?.articles?.map((a) => a?.title).filter(Boolean).slice(0, 5) ||
      [];
    out.push({ term, score: clamp(score, 1, 999), related });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

function tzFromGeo(geo) {
  // trends api의 tz는 "minutes offset" 형태를 기대하는 경우가 많음(예: -540 = KST)
  if (geo === "KR") return "-540";
  if (geo === "JP") return "-540";
  if (geo === "US") return "0";
  return "-540";
}

/* ---------------------------- YouTube ---------------------------- */

async function providerYouTube({ tf, geo, hl, q }) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    return makeMock({
      tf,
      geo,
      hl,
      note: "YOUTUBE_API_KEY가 없어 YouTube는 mock으로 대체됨",
      sourceRequested: "youtube",
    });
  }

  // 기본: mostPopular (search는 쿼터가 비싸서 여기서는 기본 비활성)
  const maxResults = 50;
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&chart=mostPopular&regionCode=${encodeURIComponent(
    geo
  )}&maxResults=${maxResults}&key=${encodeURIComponent(key)}`;

  const j = await fetchJson(url, { timeoutMs: 10000 });

  const titles = (j.items || []).map((v) => v?.snippet?.title).filter(Boolean);
  const { topTerms, termToRelated } = deriveKeywordsFromTitles(titles);

  const items = topTerms.slice(0, 20).map((t, idx) => ({
    rank: idx + 1,
    term: t.term,
    score: t.score,
    related: (termToRelated.get(t.term) || []).slice(0, 8),
    series: syntheticSeries(tf, t.term, t.score),
    links: buildLinks(t.term, geo, hl),
  }));

  return {
    items,
    meta: {
      source: "youtube",
      isMock: false,
      seriesIsSynthetic: true,
      note: q ? "q 파라미터는 현재 키워드 링크 생성에만 사용" : "YouTube mostPopular 기반 키워드 추출",
    },
  };
}

/* ---------------------------- HackerNews ---------------------------- */

async function providerHackerNews({ tf, geo, hl }) {
  const url = "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=100";
  const j = await fetchJson(url, { timeoutMs: 10000 });

  const titles = (j.hits || []).map((h) => h?.title).filter(Boolean);
  const { topTerms, termToRelated } = deriveKeywordsFromTitles(titles);

  const items = topTerms.slice(0, 20).map((t, idx) => ({
    rank: idx + 1,
    term: t.term,
    score: t.score,
    related: (termToRelated.get(t.term) || []).slice(0, 8),
    series: syntheticSeries(tf, t.term, t.score),
    links: buildLinks(t.term, geo, hl),
  }));

  return {
    items,
    meta: { source: "hackernews", isMock: false, seriesIsSynthetic: true, note: "HN front_page 기반" },
  };
}

/* ---------------------------- Reddit ---------------------------- */

async function providerReddit({ tf, geo, hl }) {
  const subs = (process.env.REDDIT_SUBS || "worldnews,technology,programming,korea")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8);

  const titles = [];
  const ua = "TrendsDashboard/1.0 (private use; vercel serverless)";

  for (const sub of subs) {
    // 1) JSON (우선 시도)
    const jsonUrl = `https://www.reddit.com/r/${encodeURIComponent(sub)}/hot.json?limit=50&raw_json=1`;
    try {
      const j = await fetchJson(jsonUrl, {
        timeoutMs: 10000,
        headers: {
          "User-Agent": ua,
          "Accept": "application/json",
          "Accept-Language": hl,
        },
      });

      const children = j?.data?.children || [];
      for (const c of children) {
        const title = c?.data?.title;
        if (title) titles.push(title);
      }
      // JSON 성공했으면 다음 서브레딧으로
      continue;
    } catch (e) {
      // JSON 실패하면 RSS로 넘어감
    }

    // 2) RSS fallback (JSON 막힐 때 훨씬 잘 살아남음)
    const rssUrl = `https://www.reddit.com/r/${encodeURIComponent(sub)}/hot.rss`;
    try {
      const xml = await fetchText(rssUrl, {
        timeoutMs: 10000,
        headers: {
          "User-Agent": ua,
          "Accept": "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
          "Accept-Language": hl,
        },
      });

      // 기존 parseRssTitles() 재사용 (item title만 뽑음)
      const rssTitles = parseRssTitles(xml);
      for (const t of rssTitles) titles.push(t);
    } catch (e) {
      // RSS도 실패하면 이 서브레딧은 스킵
    }
  }

  if (!titles.length) {
    return makeMock({
      tf,
      geo,
      hl,
      note: "Reddit fetch 실패(레이트리밋/차단/네트워크)로 mock 대체됨. RSS fallback까지 실패.",
      sourceRequested: "reddit",
    });
  }

  const { topTerms, termToRelated } = deriveKeywordsFromTitles(titles);

  const items = topTerms.slice(0, 20).map((t, idx) => ({
    rank: idx + 1,
    term: t.term,
    score: t.score,
    related: (termToRelated.get(t.term) || []).slice(0, 8),
    series: syntheticSeries(tf, t.term, t.score),
    links: buildLinks(t.term, geo, hl),
  }));

  return {
    items,
    meta: {
      source: "reddit",
      isMock: false,
      seriesIsSynthetic: true,
      note: `Reddit 기반 (JSON 우선 + RSS fallback) / r/${subs.join(", r/")}`,
    },
  };
}


/* ---------------------------- Naver DataLab (Seed 기반) ---------------------------- */

async function providerNaverDataLab({ tf, geo, hl, req }) {
  const id = process.env.NAVER_CLIENT_ID;
  const secret = process.env.NAVER_CLIENT_SECRET;

  if (!id || !secret) {
    return makeMock({
      tf,
      geo,
      hl,
      note: "NAVER_CLIENT_ID / NAVER_CLIENT_SECRET이 없어 Naver DataLab은 mock으로 대체됨",
      sourceRequested: "naverDataLab",
    });
  }

  // DataLab은 “전체 TOP20”이 아니라 “내가 정한 키워드들의 추이” API임
  // (keywordGroups 최대 5개 제한) → 5개씩 쪼개서 여러 번 호출해 20개까지 확장
  const seeds = getNaverSeeds(req).slice(0, 20);
  if (!seeds.length) {
    return makeMock({ tf, geo, hl, note: "NAVER_SEEDS 또는 seeds 파라미터가 비어있어 mock 대체", sourceRequested: "naverDataLab" });
  }

  const { startDate, endDate, timeUnit } = naverDateRange(tf);

  const chunks = chunk(seeds, 5);
  const results = [];

  for (const chunkSeeds of chunks) {
    const body = {
      startDate,
      endDate,
      timeUnit, // date | week | month
      keywordGroups: chunkSeeds.map((k) => ({ groupName: k, keywords: [k] })),
    };

    const j = await fetchJson("https://openapi.naver.com/v1/datalab/search", {
      method: "POST",
      timeoutMs: 12000,
      headers: {
        "Content-Type": "application/json",
        "X-Naver-Client-Id": id,
        "X-Naver-Client-Secret": secret,
      },
      body: JSON.stringify(body),
    });

    const arr = j?.results || [];
    for (const r of arr) {
      const term = (r?.title || "").toString().trim();
      const seriesRaw = (r?.data || []).map((d) => Number(d?.ratio) || 0);

      // tf가 hour면 DataLab은 시간단위가 없으니, 일단 일간 데이터를 24칸으로 “늘려서” UI가 깨지지 않게 함
      const series = tf === "hour" ? upsampleTo24(seriesRaw) : seriesRaw;

      const score = series.length ? series[series.length - 1] : 0;
      results.push({
        term,
        score,
        series: series.length ? series : syntheticSeries(tf, term, score),
      });
    }
  }

  results.sort((a, b) => b.score - a.score);

  const top = results.slice(0, 20).map((it, idx) => ({
    rank: idx + 1,
    term: it.term,
    score: it.score,
    related: [],
    series: it.series,
    links: buildLinks(it.term, geo, hl),
  }));

  return {
    items: top,
    meta: {
      source: "naverDataLab",
      isMock: false,
      seriesIsSynthetic: tf === "hour",
      note:
        "Naver DataLab은 ‘Seed 키워드 후보군’ 기반 TOP. hour 탭은 DataLab 제약상 일간 데이터를 24칸으로 보정",
    },
  };
}

function getNaverSeeds(req) {
  const raw = (req?.query?.seeds || process.env.NAVER_SEEDS || "")
    .toString()
    .trim();
  if (raw) return raw.split(",").map((s) => s.trim()).filter(Boolean);

  // 기본 seed (원하면 NAVER_SEEDS로 덮어쓰기)
  return [
    "테슬라",
    "비트코인",
    "이더리움",
    "엔비디아",
    "나스닥",
    "금리",
    "환율",
    "부동산",
    "아이폰",
    "갤럭시",
    "AI",
    "ChatGPT",
    "유튜브",
    "넷플릭스",
    "코스피",
    "코스닥",
    "ETF",
    "S&P500",
    "도지코인",
    "솔라나",
  ];
}

function naverDateRange(tf) {
  // DataLab은 보통 당일 데이터가 즉시 반영되지 않는 경우가 있어 endDate는 '어제'로 잡는 게 안정적
  const end = new Date();
  end.setDate(end.getDate() - 1);

  const start = new Date(end);
  let timeUnit = "date";
  if (tf === "hour") {
    // hour는 지원 안 됨 → 최근 7일 일간으로
    start.setDate(start.getDate() - 7);
    timeUnit = "date";
  } else if (tf === "day") {
    start.setDate(start.getDate() - 7);
    timeUnit = "date";
  } else if (tf === "week") {
    start.setDate(start.getDate() - 56); // 8주
    timeUnit = "week";
  } else {
    start.setMonth(start.getMonth() - 12);
    timeUnit = "month";
  }

  return { startDate: fmtDate(start), endDate: fmtDate(end), timeUnit };
}

function fmtDate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function upsampleTo24(arr) {
  if (!arr || !arr.length) return Array.from({ length: 24 }, () => 0);
  // 단순히 마지막 값 기준으로 부드럽게 채움(UI용)
  const last = arr[arr.length - 1];
  const base = Math.max(1, last);
  return Array.from({ length: 24 }, (_, i) => {
    const t = i / 23;
    return Math.max(0, Math.round(base * (0.6 + 0.4 * t)));
  });
}

/* ---------------------------- Shared Helpers ---------------------------- */

function normalizeResponse(data, { source, tf, geo, hl }) {
  const items = Array.isArray(data?.items) ? data.items : [];
  const meta = data?.meta || {};
  return {
    items: items.slice(0, 20).map((it, i) => ({
      rank: it.rank || i + 1,
      term: String(it.term || "").trim(),
      score: Number(it.score || 0),
      series: Array.isArray(it.series) ? it.series : syntheticSeries(tf, it.term || "", Number(it.score || 0)),
      related: Array.isArray(it.related) ? it.related : [],
      links: it.links || buildLinks(String(it.term || "").trim(), geo, hl),
    })),
    meta: {
      source,
      tf,
      geo,
      hl,
      isMock: Boolean(meta.isMock),
      seriesIsSynthetic: Boolean(meta.seriesIsSynthetic),
      note: meta.note || "",
    },
  };
}

function withMeta(payload, extraMeta) {
  return {
    ...payload,
    meta: {
      ...(payload.meta || {}),
      ...(extraMeta || {}),
      lastUpdatedAt: Date.now(),
    },
  };
}

function buildLinks(term, geo, hl) {
  const q = encodeURIComponent(term);
  return {
    google: `https://www.google.com/search?q=${q}`,
    news: `https://news.google.com/search?q=${q}&hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(geo)}`,
    youtube: `https://www.youtube.com/results?search_query=${q}`,
  };
}

function makeMock({ tf, geo, hl, note, sourceRequested }) {
  const terms = [
    "AI", "Bitcoin", "Tesla", "NVIDIA", "KOSPI", "Fed", "iPhone", "YouTube", "Netflix", "ETF",
    "DOGE", "SOL", "ETH", "USD/KRW", "Gold", "Oil", "ChatGPT", "Game", "Elections", "Sports"
  ];
  const items = terms.slice(0, 20).map((t, i) => {
    const score = 100 - i * 3;
    return {
      rank: i + 1,
      term: t,
      score,
      series: syntheticSeries(tf, t, score),
      related: [],
      links: buildLinks(t, geo, hl),
    };
  });
  return {
    items,
    meta: {
      source: sourceRequested || "mock",
      tf,
      geo,
      hl,
      isMock: true,
      seriesIsSynthetic: true,
      note: note || "mock fallback",
    },
  };
}

function syntheticSeries(tf, term, score) {
  const len = tf === "hour" ? 24 : tf === "day" ? 7 : tf === "week" ? 8 : 12;
  const seed = hash(term) % 997;
  const base = clamp(score || 50, 1, 999);
  const out = [];
  for (let i = 0; i < len; i++) {
    const noise = ((seed * (i + 1) * 17) % 23) - 11;
    const drift = (i - (len - 1) / 2) * 0.7;
    out.push(Math.max(0, Math.round(base + noise + drift)));
  }
  return out;
}

function deriveKeywordsFromTitles(titles) {
  const stop = new Set([
    "the","a","an","and","or","to","of","in","on","for","with","is","are","was","were",
    "this","that","it","as","at","by","from","be",
    "영상","오늘","관련","공개","발표","사실","충격","속보","단독","논란","근황","정리",
    "하는","하는법","방법","있다","된다","하다","했다","합니다",
  ]);

  const freq = new Map();
  const related = new Map();

  for (let idx = 0; idx < titles.length; idx++) {
    const title = String(titles[idx] || "");
    const tokens = tokenize(title).filter((w) => w.length >= 2 && !stop.has(w.toLowerCase()));
    const uniq = Array.from(new Set(tokens)).slice(0, 12);

    const weight = Math.max(1, Math.round(10 - idx / 10)); // 앞쪽 아이템 가중치
    for (const w of uniq) {
      freq.set(w, (freq.get(w) || 0) + weight);
    }

    // co-occur 기반 related
    for (let i = 0; i < uniq.length; i++) {
      const a = uniq[i];
      if (!related.has(a)) related.set(a, new Map());
      const m = related.get(a);
      for (let j = 0; j < uniq.length; j++) {
        if (i === j) continue;
        const b = uniq[j];
        m.set(b, (m.get(b) || 0) + 1);
      }
    }
  }

  const topTerms = Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50)
    .map(([term, score]) => ({ term, score }));

  const termToRelated = new Map();
  for (const { term } of topTerms) {
    const m = related.get(term);
    if (!m) continue;
    const arr = Array.from(m.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([w]) => w);
    termToRelated.set(term, arr);
  }

  return { topTerms, termToRelated };
}

function tokenize(s) {
  return String(s)
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0);
}

function safeErr(e) {
  return (e && (e.message || String(e))) ? String(e.message || e) : "unknown error";
}

/* ---------------------------- Fetch Helpers ---------------------------- */

async function fetchJson(url, opt = {}) {
  const text = await fetchText(url, opt);
  return JSON.parse(text);
}

async function fetchText(url, opt = {}) {
  const timeoutMs = opt.timeoutMs || 10000;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      method: opt.method || "GET",
      headers: opt.headers || {},
      body: opt.body,
      signal: controller.signal,
    });

    // 429/5xx 처리
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status} ${resp.statusText} :: ${body.slice(0, 200)}`);
    }
    return await resp.text();
  } finally {
    clearTimeout(t);
  }
}
