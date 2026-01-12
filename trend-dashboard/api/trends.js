/**
 * /api/trends.js (Vercel Serverless Function)
 * - CORS + CDN cache header + 메모리 캐시
 * - source 플러그형: storyKR, googleTrends, youtubeSuggest, news, reddit, hackernews, mock
 *
 * 사용 예)
 *  - /api/trends?source=storyKR&geo=KR&limit=20
 *  - /api/trends?source=googleTrends&geo=KR
 *  - /api/trends?source=youtubeSuggest&q=연애%20썰
 *  - /api/trends?source=news&q=연애
 *  - /api/trends?source=reddit&sub=AskReddit
 *  - /api/trends?source=hackernews
 *  - /api/trends?source=mock
 *
 * 옵션:
 *  - limit: 기본 20 (최대 50)
 *  - cacheTtlSec: 기본 60 (CDN 캐시와 별개, 함수 메모리 캐시)
 *  - force=1: 캐시 무시하고 새로 수집
 */

const memCache = global.__TREND_MEM_CACHE__ || new Map();
global.__TREND_MEM_CACHE__ = memCache;

function nowMs() {
  return Date.now();
}

function clamp(n, min, max) {
  const x = Number(n);
  if (Number.isNaN(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function pickStr(v, fallback = "") {
  if (typeof v !== "string") return fallback;
  return v.trim();
}

function normalizeSource(s) {
  const x = pickStr(s, "storyKR").toLowerCase();
  const allowed = new Set([
    "storykr",
    "googletrends",
    "youtubesuggest",
    "news",
    "reddit",
    "hackernews",
    "mock",
  ]);
  return allowed.has(x) ? x : "storykr";
}

function cacheKeyFromReq(req) {
  // query key를 안정적으로 만들기
  const url = new URL(req.url, "http://localhost");
  const params = [...url.searchParams.entries()]
    .filter(([k]) => k !== "force")
    .sort(([a], [b]) => (a > b ? 1 : -1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return `${url.pathname}?${params}`;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(url, options = {}, retry = 2) {
  let lastErr;
  for (let i = 0; i <= retry; i++) {
    try {
      const res = await fetch(url, {
        ...options,
        headers: {
          "User-Agent":
            options.headers?.["User-Agent"] ||
            "Mozilla/5.0 (compatible; TrendDashboard/1.0; +https://vercel.com)",
          ...options.headers,
        },
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        const err = new Error(`HTTP ${res.status} ${res.statusText} :: ${txt.slice(0, 200)}`);
        err.status = res.status;
        throw err;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (i < retry) {
        await sleep(250 * Math.pow(2, i));
        continue;
      }
    }
  }
  throw lastErr;
}

function xmlToTextItems(xml) {
  // 매우 단순 RSS 파서(외부 라이브러리 없이)
  // <item><title>...</title><pubDate>...</pubDate></item>
  const items = [];
  const itemBlocks = xml.split("<item>").slice(1);
  for (const blk of itemBlocks) {
    const title = (blk.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || blk.match(/<title>(.*?)<\/title>/))?.[1];
    const pubDate = (blk.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1];
    if (title) items.push({ title: decodeHtml(title.trim()), pubDate: pubDate?.trim() || "" });
  }
  return items;
}

function decodeHtml(s) {
  return s
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function uniqByTitle(list) {
  const seen = new Set();
  const out = [];
  for (const x of list) {
    const k = (x.title || "").toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

function makeStoryAngles(term) {
  // “썰 상황형” 아주 간단 변환 (API에서 가볍게)
  // 실제 각색은 앱에서 GPT 붙여넣기로 더 강하게 만들면 됨
  const t = term.trim();
  return [
    `${t} 때문에 헤어진 썰`,
    `${t} 한마디에 분위기 싸해진 썰`,
    `나만 ${t} 이해 안 되는 썰`,
    `상대가 ${t} 하길래 정 떨어진 썰`,
    `친구가 ${t} 했다가 레전드 된 썰`,
  ];
}

async function getGoogleTrendsRssDaily(geo = "KR") {
  // 구글 트렌드 Daily RSS (공식 RSS 형태)
  const url = `https://trends.google.com/trends/trendingsearches/daily/rss?geo=${encodeURIComponent(geo)}`;
  const res = await fetchWithRetry(url, { method: "GET" }, 2);
  const xml = await res.text();
  const items = xmlToTextItems(xml);
  // title이 "검색어" 형태로 들어옴
  return uniqByTitle(items).map((x) => ({
    term: x.title,
    pubDate: x.pubDate,
    source: "googleTrendsDailyRss",
  }));
}

async function getGoogleTrendsRssRealtime(geo = "KR", category = "all") {
  // 실시간 RSS
  const url = `https://trends.google.com/trends/trendingsearches/realtime/rss?geo=${encodeURIComponent(
    geo
  )}&category=${encodeURIComponent(category)}`;
  const res = await fetchWithRetry(url, { method: "GET" }, 2);
  const xml = await res.text();
  const items = xmlToTextItems(xml);
  return uniqByTitle(items).map((x) => ({
    term: x.title,
    pubDate: x.pubDate,
    source: "googleTrendsRealtimeRss",
  }));
}

async function getYouTubeSuggest(q) {
  const query = pickStr(q, "");
  if (!query) return [];
  // YouTube 자동완성(비공식, 가벼운 수요 검증용)
  const url = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(
    query
  )}`;
  const res = await fetchWithRetry(url, { method: "GET" }, 1);
  const data = await res.json().catch(() => null);
  // 형태: [query, [suggest1, suggest2...]]
  const arr = Array.isArray(data) ? data[1] : [];
  return (Array.isArray(arr) ? arr : []).filter(Boolean).slice(0, 20);
}

async function getGoogleNewsRss(q, hl = "ko", gl = "KR", ceid = "KR:ko") {
  const query = pickStr(q, "");
  if (!query) return [];
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${encodeURIComponent(
    hl
  )}&gl=${encodeURIComponent(gl)}&ceid=${encodeURIComponent(ceid)}`;
  const res = await fetchWithRetry(url, { method: "GET" }, 2);
  const xml = await res.text();
  const items = xmlToTextItems(xml);
  return uniqByTitle(items).slice(0, 30).map((x) => ({
    title: x.title,
    pubDate: x.pubDate,
    source: "googleNewsRss",
  }));
}

async function getRedditHot(sub = "AskReddit", limit = 20) {
  const s = pickStr(sub, "AskReddit").replaceAll("/", "");
  const url = `https://www.reddit.com/r/${encodeURIComponent(s)}/hot.json?limit=${clamp(limit, 1, 50)}`;
  const res = await fetchWithRetry(
    url,
    { method: "GET", headers: { "User-Agent": "TrendDashboard/1.0 (personal use)" } },
    1
  );
  const json = await res.json();
  const children = json?.data?.children || [];
  return children
    .map((c) => c?.data)
    .filter(Boolean)
    .map((d) => ({
      title: d.title,
      score: d.score,
      comments: d.num_comments,
      url: `https://www.reddit.com${d.permalink}`,
      source: `reddit:r/${s}`,
    }))
    .slice(0, clamp(limit, 1, 50));
}

async function getHackerNewsFrontPage(limit = 20) {
  // HN Algolia front_page
  const url = "https://hn.algolia.com/api/v1/search?tags=front_page";
  const res = await fetchWithRetry(url, { method: "GET" }, 1);
  const json = await res.json();
  const hits = json?.hits || [];
  return hits
    .map((h) => ({
      title: h.title || h.story_title || "",
      points: h.points || 0,
      url: h.url || h.story_url || "",
      created_at: h.created_at || "",
      source: "hackernews:front_page",
    }))
    .filter((x) => x.title)
    .slice(0, clamp(limit, 1, 50));
}

function respondJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj, null, 2));
}

module.exports = async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  // CDN Cache (Vercel Edge Cache)
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");

  const startedAt = nowMs();

  try {
    const url = new URL(req.url, "http://localhost");
    const source = normalizeSource(url.searchParams.get("source"));
    const limit = clamp(url.searchParams.get("limit") || "20", 1, 50);
    const geo = pickStr(url.searchParams.get("geo"), "KR");
    const category = pickStr(url.searchParams.get("category"), "all");
    const q = pickStr(url.searchParams.get("q"), "");
    const sub = pickStr(url.searchParams.get("sub"), "AskReddit");
    const force = pickStr(url.searchParams.get("force"), "") === "1";
    const cacheTtlSec = clamp(url.searchParams.get("cacheTtlSec") || "60", 10, 3600);

    // 메모리 캐시
    const key = cacheKeyFromReq(req);
    const cached = memCache.get(key);
    if (!force && cached && nowMs() - cached.savedAt < cacheTtlSec * 1000) {
      return respondJson(res, 200, {
        ok: true,
        cached: true,
        source,
        key,
        generatedAt: new Date(cached.savedAt).toISOString(),
        elapsedMs: nowMs() - startedAt,
        data: cached.data,
      });
    }

    // source 처리
    let data = null;

    if (source === "mock") {
      data = {
        items: Array.from({ length: limit }).map((_, i) => ({
          rank: i + 1,
          term: `테스트 키워드 ${i + 1}`,
          score: 100 - i,
          sources: ["mock"],
          storyAngles: makeStoryAngles(`테스트 키워드 ${i + 1}`),
        })),
      };
    }

    if (source === "googletrends") {
      const daily = await getGoogleTrendsRssDaily(geo);
      const realtime = await getGoogleTrendsRssRealtime(geo, category);
      const merged = uniqByTitle(
        [...realtime.map((x) => ({ title: x.term })), ...daily.map((x) => ({ title: x.term }))]
      ).map((x) => x.title);

      data = {
        geo,
        category,
        items: merged.slice(0, limit).map((term, i) => ({
          rank: i + 1,
          term,
          sources: ["googleTrendsRealtimeRss", "googleTrendsDailyRss"],
        })),
      };
    }

    if (source === "youtubesuggest") {
      const suggest = await getYouTubeSuggest(q);
      data = {
        q,
        items: suggest.slice(0, limit).map((s, i) => ({
          rank: i + 1,
          term: s,
          sources: ["youtubeSuggest"],
        })),
      };
    }

    if (source === "news") {
      const items = await getGoogleNewsRss(q || "유튜브 쇼츠");
      data = {
        q: q || "유튜브 쇼츠",
        items: items.slice(0, limit).map((x, i) => ({
          rank: i + 1,
          term: x.title,
          pubDate: x.pubDate,
          sources: [x.source],
        })),
      };
    }

    if (source === "reddit") {
      const items = await getRedditHot(sub, limit);
      data = {
        sub,
        items: items.map((x, i) => ({
          rank: i + 1,
          term: x.title,
          score: x.score,
          comments: x.comments,
          url: x.url,
          sources: [x.source],
        })),
      };
    }

    if (source === "hackernews") {
      const items = await getHackerNewsFrontPage(limit);
      data = {
        items: items.map((x, i) => ({
          rank: i + 1,
          term: x.title,
          points: x.points,
          url: x.url,
          created_at: x.created_at,
          sources: [x.source],
        })),
      };
    }

    if (source === "storykr") {
      // 1) 트렌드 수집(가볍게)
      const realtime = await getGoogleTrendsRssRealtime(geo, category);
      const daily = await getGoogleTrendsRssDaily(geo);

      const mergedTerms = uniqByTitle(
        [...realtime.map((x) => ({ title: x.term })), ...daily.map((x) => ({ title: x.term }))]
      )
        .map((x) => x.title)
        .slice(0, Math.max(10, Math.min(25, limit)));

      // 2) “썰 각색” 후보 만들기
      const candidates = mergedTerms.flatMap((term) =>
        makeStoryAngles(term).slice(0, 2).map((angle) => ({ term, angle }))
      );

      // 3) 유튜브 자동완성으로 수요 검증(비용 0원, 가벼운 힌트용)
      //    너무 무거워지지 않게 상위 일부만 체크
      const checkN = Math.min(12, candidates.length);
      const checked = [];
      for (let i = 0; i < checkN; i++) {
        const c = candidates[i];
        const sug = await getYouTubeSuggest(c.angle);
        checked.push({
          term: c.term,
          angle: c.angle,
          suggestCount: sug.length,
          suggestTop: sug.slice(0, 5),
        });
        // 과호출 방지(살짝 텀)
        await sleep(80);
      }

      // 4) 점수화 (suggestCount 중심)
      checked.sort((a, b) => b.suggestCount - a.suggestCount);

      const top = checked.slice(0, limit).map((x, i) => ({
        rank: i + 1,
        term: x.term,
        score: x.suggestCount,
        storyAngle: x.angle,
        youtubeSuggestTop: x.suggestTop,
        sources: ["googleTrendsRss", "youtubeSuggest"],
        note:
          x.suggestCount === 0
            ? "자동완성 수요 신호 약함(아이디어만 참고)"
            : "자동완성 수요 신호 있음",
      }));

      data = {
        geo,
        category,
        items: top,
      };
    }

    if (!data) {
      return respondJson(res, 400, {
        ok: false,
        error: "지원하지 않는 source 입니다",
        hint: "source=storyKR | googleTrends | youtubeSuggest | news | reddit | hackernews | mock",
      });
    }

    // 캐시 저장
    memCache.set(key, { savedAt: nowMs(), data });

    return respondJson(res, 200, {
      ok: true,
      cached: false,
      source,
      generatedAt: new Date().toISOString(),
      elapsedMs: nowMs() - startedAt,
      data,
    });
  } catch (e) {
    const msg = pickStr(e?.message, "알 수 없는 오류");
    const status = e?.status && Number.isInteger(e.status) ? e.status : 500;

    return respondJson(res, status, {
      ok: false,
      error: msg,
      tip:
        "대부분 (1) 외부 RSS/JSON 일시 오류 (2) 경로/쿼리 파라미터 오타 (3) 너무 잦은 호출 때문이야. force=1로 재시도하거나 cacheTtlSec를 늘려봐.",
    });
  }
};
