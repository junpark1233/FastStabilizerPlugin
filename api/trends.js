// /api/trends.js
// Vercel Serverless Function
// - 소스 플러그형: storyKR(썰최적화), youtube, googleTrends, news, naver, reddit, hackernews, mock
// - CORS + CDN 캐시 + 메모리 캐시
// - storyKR: (Trends/News/YouTube) 원천 수집 → 썰 상황형 변환 → YouTube 자동완성(suggest)로 수요 검증 → TOP20

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  // ✅ JSON charset 강제 (브라우저/프리티파이어에서 한글 깨짐 방지)
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  // CDN cache (개인용 비용/호출수 절감)
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");

  const startedAt = Date.now();

  try {
    const source = normalizeSource((req.query.source ?? "storyKR").toString());

    const tf = normalizeTf(((req.query.tf ?? req.query.timeframe ?? "hour") || "hour").toString());
    const geo = (((req.query.geo ?? req.query.country ?? "KR") || "KR").toString()).toUpperCase();
    const hl = (((req.query.hl ?? req.query.lang ?? "ko") || "ko").toString()).toLowerCase();

    const cat = ((req.query.cat ?? "all") || "all").toString();
    const q = ((req.query.q ?? "") || "").toString().trim();

    const cacheKey = JSON.stringify({ source, tf, geo, hl, cat, q });
    const fresh = memGet(cacheKey, 45_000);
    if (fresh) return res.status(200).json(withMeta(fresh, { tookMs: Date.now() - startedAt }));

    const stale = memGetAny(cacheKey);

    let payload;
    try {
      payload = await dispatchProvider({ source, tf, geo, hl, cat });
    } catch (err) {
      // 실패 시 graceful fallback
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
        payload = makeMock(tf, geo, hl, { note: `provider 실패 → mock: ${err?.message || String(err)}`, isMock: true });
      }
    }

    // ✅ 서버측 q 필터
    if (q && Array.isArray(payload?.items)) {
      const qq = q.toLowerCase();
      payload.items = payload.items.filter((x) => String(x.term || "").toLowerCase().includes(qq));
      payload.items.forEach((x, i) => (x.rank = i + 1));
    }

    // ✅ 최종 한번 더 “깨진 문자/이상 토큰” 클린업 (UI에 ‘����’ 안 뜨게)
    if (Array.isArray(payload?.items)) {
      payload.items = payload.items
        .map(cleanItemDeep)
        .filter((it) => it && isUsableTerm(it.term, hl));
      payload.items.forEach((x, i) => (x.rank = i + 1));
      payload.items = payload.items.slice(0, 20);
    }

    payload = withMeta(payload, { tookMs: Date.now() - startedAt });

    memSet(cacheKey, payload);
    memSetAny(cacheKey, payload);

    return res.status(200).json(payload);
  } catch (e) {
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
 * In-memory cache
 * ---------------------- */
function memMap() {
  globalThis.__TRENDS_PROXY_CACHE__ ||= new Map();
  return globalThis.__TRENDS_PROXY_CACHE__;
}
function memGet(key, ttlMs) {
  const m = memMap();
  const v = m.get(key);
  if (!v?.ts) return null;
  if (Date.now() - v.ts > ttlMs) return null;
  return v.data;
}
function memSet(key, data) {
  memMap().set(key, { ts: Date.now(), data });
}
function memGetAny(key) {
  const v = memMap().get(key);
  return v?.data || null;
}
function memSetAny(key, data) {
  memMap().set(key, { ts: Date.now(), data });
}

/* -----------------------
 * Normalizers
 * ---------------------- */
function normalizeSource(s) {
  const x = String(s || "").toLowerCase();
  if (x === "storykr" || x.includes("story")) return "storyKR";
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

  if (source === "storyKR") return fromStoryKR({ tf, geo, hl });

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

  return makeMock(tf, geo, hl, { note: `unknown source(${source}) → mock`, isMock: true });
}

/* -----------------------
 * Encoding-aware fetch helpers
 * ---------------------- */

// iconv-lite가 있으면 EUC-KR/CP949까지 완벽 디코딩 가능
let __ICONV = null;
async function getIconv() {
  if (__ICONV !== null) return __ICONV;
  try {
    const m = await import("iconv-lite");
    __ICONV = m?.default || m;
  } catch {
    __ICONV = undefined;
  }
  return __ICONV;
}

function sniffCharsetFromHeaders(headers) {
  const ct = headers?.get?.("content-type") || "";
  const m = /charset\s*=\s*([^\s;]+)/i.exec(ct);
  return m ? String(m[1]).trim() : "";
}
function sniffCharsetFromXmlProlog(bytes) {
  try {
    // xml prolog는 ASCII 범위라 latin1로 대충 읽어도 됨
    const head = new TextDecoder("latin1").decode(bytes.slice(0, 2048));
    const m = /<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i.exec(head);
    return m ? String(m[1]).trim() : "";
  } catch {
    return "";
  }
}
function normalizeCharsetName(cs) {
  const x = String(cs || "").toLowerCase().replace(/[_\s]/g, "");
  if (!x) return "";
  if (x === "utf8" || x === "utf-8") return "utf-8";
  if (x === "utf16" || x === "utf-16") return "utf-16";
  if (x === "utf16le" || x === "utf-16le") return "utf-16le";
  if (x === "latin1" || x === "iso-8859-1" || x === "iso88591" || x === "windows-1252") return "latin1";
  if (
    x === "euc-kr" || x === "euckr" || x === "cp949" || x === "windows-949" ||
    x === "ksc5601" || x === "ksc_5601-1987" || x === "ksc5601-1987" || x === "ksc_5601_1987"
  ) return "euc-kr";
  return x;
}
async function decodeBytes(bytes, charset) {
  const cs = normalizeCharsetName(charset) || "utf-8";

  // node TextDecoder가 지원하는 범위: utf-8/utf-16/latin1
  if (cs === "utf-8" || cs === "utf8") return new TextDecoder("utf-8").decode(bytes);
  if (cs === "utf-16" || cs === "utf-16le") return new TextDecoder("utf-16le").decode(bytes);
  if (cs === "latin1") return new TextDecoder("latin1").decode(bytes);

  // euc-kr/cp949 등은 iconv-lite가 있으면 복구
  if (cs === "euc-kr" || cs === "cp949") {
    const iconv = await getIconv();
    if (iconv?.decode) {
      // iconv-lite는 Buffer 필요
      return iconv.decode(Buffer.from(bytes), "cp949"); // cp949가 euc-kr 상위호환
    }
    // iconv 없으면 어쩔 수 없이 utf-8로(대신 깨진 토큰 제거가 뒤에서 동작)
    return new TextDecoder("utf-8").decode(bytes);
  }

  // 기타는 utf-8 fallback
  return new TextDecoder("utf-8").decode(bytes);
}

function sanitizeText(s) {
  if (typeof s !== "string") s = String(s ?? "");
  // 제어문자 제거(개행/탭은 유지)
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  // U+FFFD(�) 제거(깨짐 방지)
  s = s.replace(/\uFFFD/g, "");
  return s;
}

async function fetchText(url, opts = {}) {
  const timeoutMs = clampInt(opts.timeoutMs ?? 9000, 1000, 20000);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const r = await fetch(url, { ...opts, signal: controller.signal });
    const ab = await r.arrayBuffer();
    const bytes = new Uint8Array(ab);

    const hCharset = sniffCharsetFromHeaders(r.headers);
    const xCharset = sniffCharsetFromXmlProlog(bytes);
    const charset = normalizeCharsetName(hCharset || xCharset || "utf-8");

    let text = await decodeBytes(bytes, charset);
    text = sanitizeText(text);

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
 * RSS/Atom parsing
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
function cleanDisplayString(s) {
  return sanitizeText(stripHtml(decodeXml(String(s || "")))).trim();
}

function parseFeedTitles(xmlText) {
  if (!xmlText || typeof xmlText !== "string") return [];
  const titles = [];
  const pushTitle = (raw) => {
    const t = cleanDisplayString(raw);
    if (!t) return;
    // 깨진 문자/의미없는 토큰 제거
    if (t.length < 2) return;
    titles.push(t);
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
  const s = sanitizeText(String(text || ""));
  const stop = buildStop(hl);

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
    // 깨진 문자 포함 제거
    if (tok.includes("�")) continue;
    out.push(tok);
  }
  return out;
}

function deriveFromTitles(titles, hl, maxTerms = 80) {
  const freq = new Map();
  const related = new Map();

  for (const title of titles) {
    const safeTitle = sanitizeText(String(title || ""));
    if (!safeTitle) continue;

    const toks = Array.from(new Set(tokenizeMixed(safeTitle, hl)));
    for (const t of toks) freq.set(t, (freq.get(t) || 0) + 1);

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
  const t = sanitizeText(String(term || ""));
  return {
    youtube: "https://www.youtube.com/results?search_query=" + encodeURIComponent(t),
    naver: "https://search.naver.com/search.naver?query=" + encodeURIComponent(t),
    google: "https://www.google.com/search?q=" + encodeURIComponent(t),
    news: "https://news.google.com/search?q=" + encodeURIComponent(t) + `&hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(geo)}`,
  };
}
function topN(items, n = 20) {
  const arr = Array.isArray(items) ? items.slice() : [];
  arr.sort((a, b) => (b.score || 0) - (a.score || 0));
  return arr.slice(0, n).map((x, i) => ({ ...x, rank: i + 1 }));
}

/* -----------------------
 * Deep cleanup to prevent broken chips
 * ---------------------- */
function cleanArrayStrings(arr, hl, limit = 12) {
  const out = [];
  const seen = new Set();
  for (const v of arr || []) {
    const s = sanitizeText(String(v || "")).trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    if (!isUsableTerm(s, hl)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

function cleanItemDeep(it) {
  if (!it || typeof it !== "object") return null;
  const term = sanitizeText(String(it.term || "")).trim();
  if (!term) return null;

  const out = { ...it, term };
  if (typeof out.searchTerm === "string") out.searchTerm = sanitizeText(out.searchTerm).trim();
  if (Array.isArray(out.tags)) out.tags = cleanArrayStrings(out.tags, "en", 8);
  if (Array.isArray(out.related)) out.related = cleanArrayStrings(out.related, "ko", 12);
  if (out.links && typeof out.links === "object") {
    // 링크는 term 기반으로 재생성(깨진 term 링크 방지)
    out.links = makeLinks(out.searchTerm || out.term, "KR", "ko");
  }
  return out;
}

// hl=ko일 때: 한글/숫자/공백/기본문장부호 비율이 너무 낮으면 제거
function isUsableTerm(s, hl) {
  if (!s) return false;
  const t = String(s);

  if (t.includes("\uFFFD") || t.includes("�")) return false;
  if (t.length < 2) return false;
  if (t.length > 60) return false;

  // 완전 이상한 기호 덩어리 제거
  const letters = (t.match(/[가-힣A-Za-z0-9]/g) || []).length;
  if (letters < Math.min(2, t.length)) {
    // 예: "::::" 같은 거
    if (t.replace(/\s+/g, "").length >= 4) return false;
  }

  if (hl === "ko") {
    const hangul = (t.match(/[가-힣]/g) || []).length;
    // ko인데 한글이 전혀 없으면(특히 related에서) 제거
    if (hangul === 0) return false;
  }

  return true;
}

/* -----------------------
 * MOCK
 * ---------------------- */
function makeMock(tf, geo, hl, metaExtra = {}) {
  const n = bucketCount(tf);
  const terms = [
    "소개팅 읽씹","환승이별 썰","회식 상사 빌런","중고거래 빌런","카톡 잠수","기념일 선물 갈등",
    "친구 돈 빌려달라","헬스장 민폐","택시 기사님 썰","카페 민망한 썰",
    "연봉 얘기하다 싸움","퇴사 통보 레전드","여친 남친 프사","썸 타다 손절","동거 스트레스",
    "부모님 잔소리","축의금 갈등","반전 고백","사이다 복수","정떨어진 순간",
  ];
  const items = terms.map((term) => {
    const base = 80 + Math.floor(Math.random() * 160);
    const series = synthSeries(n, base);
    return {
      term,
      series,
      score: scoreFromSeries(series),
      tags: ["mock"],
      related: makeDefaultRelated(term),
      links: makeLinks(term, geo, hl),
    };
  });

  return {
    items: topN(items, 20),
    meta: {
      source: "mock",
      isMock: true,
      seriesIsSynthetic: true,
      keywordsAreLive: false,
      fetchedAt: nowIso(),
      ...metaExtra,
    },
  };
}

/* -----------------------
 * storyKR (썰최적화 엔진)
 * ---------------------- */
// ---- 아래부터는 네 기존 코드 로직을 그대로 유지(중간중간 sanitize만 추가) ----

async function fromStoryKR({ tf, geo, hl }) {
  const n = bucketCount(tf);
  const debug = { steps: {}, errors: [] };

  const raw = await gatherRawSignals({ geo, hl, debug });
  if (raw.length < 8) {
    return makeMock(tf, geo, hl, {
      source: "storyKR",
      note: "원천 신호 부족 → mock",
      isMock: true,
      debug,
    });
  }

  const candidates = makeStoryCandidates(raw, { hl });
  debug.steps.candidateCount = candidates.length;

  candidates.sort((a, b) => b.preScore - a.preScore);
  const preTop = candidates.slice(0, 70);
  debug.steps.preTopCount = preTop.length;

  const enriched = await enrichWithYouTubeSuggest(preTop, { geo, hl, debug });

  for (const it of enriched) {
    it.score = Math.round(it.demandScore * 0.45 + it.storyFitScore * 0.35 + it.freshnessScore * 0.20);
    const base = 60 + it.score * 3;
    it.series = synthSeries(n, base);
    it.links = makeLinks(it.searchTerm || it.term, geo, hl);
  }

  enriched.sort((a, b) => (b.score || 0) - (a.score || 0));
  const top = enriched.slice(0, 20).map((it) => ({
    term: sanitizeText(it.term),
    searchTerm: sanitizeText(it.searchTerm),
    tags: it.tags,
    score: it.score,
    series: it.series,
    related: cleanArrayStrings(it.related, "ko", 12),
    links: it.links,
  }));

  return {
    items: topN(top, 20),
    meta: {
      source: "storyKR",
      isMock: false,
      keywordsAreLive: true,
      seriesIsSynthetic: true,
      note: "KR 썰 최적화: (YouTube/Trends/News) 원천 → 상황형 변환 → YouTube 자동완성으로 수요 검증 → TOP20",
      fetchedAt: nowIso(),
      debug,
    },
  };
}

async function gatherRawSignals({ geo, hl, debug }) {
  const out = new Map();
  const add = (term, w, source) => {
    const t = normalizeKoreanTerm(term);
    if (!t) return;
    const v = out.get(t) || { term: t, weight: 0, sources: new Set() };
    v.weight += w;
    v.sources.add(source);
    out.set(t, v);
  };

  try {
    const url = `https://trends.google.com/trends/trendingsearches/realtime/rss?geo=${encodeURIComponent(geo)}&category=all`;
    const r = await fetchText(url, { timeoutMs: 9000, headers: { "User-Agent": "trends-proxy/1.0" } });
    if (r.ok && r.text) {
      const terms = parseFeedTitles(r.text).slice(0, 80);
      debug.steps.trendsTerms = terms.length;
      terms.forEach((t, i) => add(t, 160 - i, "trends"));
    }
  } catch (e) {
    debug.errors.push({ step: "trends", error: e?.message || String(e) });
  }

  try {
    const ceid = `${geo}:${hl}`;
    const url = `https://news.google.com/rss?hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(geo)}&ceid=${encodeURIComponent(ceid)}`;
    const r = await fetchText(url, { timeoutMs: 9000, headers: { "User-Agent": "trends-proxy/1.0" } });
    if (r.ok && r.text) {
      const titlesRaw = parseFeedTitles(r.text).slice(0, 150).map((t) => String(t).split(" - ")[0]);
      const { top } = deriveFromTitles(titlesRaw, hl, 120);
      debug.steps.newsTokens = top.length;
      top.forEach(({ term, count }, i) => add(term, Math.min(90, count * 15) + (120 - i), "news"));
    }
  } catch (e) {
    debug.errors.push({ step: "news", error: e?.message || String(e) });
  }

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
        const titles = r.json.items.map((it) => sanitizeText(String(it?.snippet?.title || ""))).filter(Boolean);
        const { top } = deriveFromTitles(titles, hl, 120);
        debug.steps.youtubeTokens = top.length;
        top.forEach(({ term, count }, i) => add(term, Math.min(110, count * 22) + (120 - i), "youtube"));
      }
    } else {
      debug.steps.youtubeTokens = 0;
    }
  } catch (e) {
    debug.errors.push({ step: "youtubeTokens", error: e?.message || String(e) });
  }

  const arr = Array.from(out.values()).map((x) => ({ term: x.term, weight: x.weight, sources: Array.from(x.sources) }));
  return arr
    .filter((x) => x.term.length >= 2)
    .filter((x) => /[가-힣]/.test(x.term))
    .slice(0, 400);
}

function normalizeKoreanTerm(term) {
  if (!term) return "";
  let t = sanitizeText(String(term)).trim();
  t = t.replace(/\s+/g, " ");
  t = t.replace(/[【】\[\]()<>{}]/g, " ");
  t = t.replace(/\s+/g, " ").trim();

  const bad = ["단독", "속보", "공식", "발표", "영상", "인터뷰", "예고", "하이라이트"];
  for (const b of bad) t = t.replace(new RegExp(b, "g"), "");
  t = t.replace(/\s+/g, " ").trim();

  if (t.length < 2) return "";
  if (/^\d+$/.test(t)) return "";
  if (t.includes("�")) return "";
  return t;
}

function makeDefaultRelated(term) {
  const base = sanitizeText(String(term || "")).replace(/\s*썰\s*/g, "").trim();
  const rel = [
    base + " 썰",
    base + " 카톡",
    base + " 후기",
    base + " 레전드",
    base + " 사이다",
    base + " 공감",
  ];
  return cleanArrayStrings(Array.from(new Set(rel)), "ko", 8);
}

// 연애/일상/직장 트리거(수요 큰 것 위주)
const TRIG_ROMANCE = [
  "연애","남친","여친","애인","썸","소개팅","카톡","읽씹","잠수","환승","이별","헤어","재회","프사","집착","서운","기념일","선물","동거","결혼","바람","양다리",
];
const TRIG_WORK = [
  "회사","직장","회식","상사","팀장","부장","사장","막내","퇴사","연봉","성과","야근","면접","인턴","부서","인사","갑질","빌런",
];
const TRIG_DAILY = [
  "친구","가족","엄마","아빠","부모","형","누나","오빠","동생","이웃","카페","헬스장","택시","버스","지하철","중고","당근","배달","치킨","편의점","공원",
  "무단횡단","교통","사고","민폐","진상","빌런","술자리","모임","축의금",
];
const EMO_TRIG = ["사이다","레전드","충격","정떨어","소름","민망","개빡","빡침","설렘","반전","최악","역대급","현타","눈물","감동"];

function hasAny(s, arr) {
  return arr.some((w) => String(s).includes(w));
}
function scoreStoryFitFromRaw(rawTerm) {
  let s = 0;
  if (hasAny(rawTerm, TRIG_ROMANCE)) s += 55;
  if (hasAny(rawTerm, TRIG_WORK)) s += 35;
  if (hasAny(rawTerm, TRIG_DAILY)) s += 30;
  if (/^[가-힣]{2,4}$/.test(rawTerm)) s -= 10;
  return clampInt(s, 0, 100);
}
function scoreFreshness(sources) {
  const set = new Set(sources || []);
  const base = 40 + set.size * 20;
  return clampInt(base, 0, 100);
}

function makeStoryCandidates(rawSignals, { hl }) {
  const candidates = new Map();
  const add = (obj) => {
    const key = obj.term;
    const prev = candidates.get(key);
    if (!prev || obj.preScore > prev.preScore) candidates.set(key, obj);
  };

  for (const rs of rawSignals) {
    const raw = sanitizeText(rs.term);
    const srcs = rs.sources || [];
    const baseFit = scoreStoryFitFromRaw(raw);
    const fresh = scoreFreshness(srcs);
    const w = rs.weight || 0;

    const isRomance = hasAny(raw, TRIG_ROMANCE);
    const isWork = hasAny(raw, TRIG_WORK);
    const isDaily = hasAny(raw, TRIG_DAILY) || (!isRomance && !isWork);

    const templates = [];

    if (isRomance) {
      templates.push(
        { t: `${pickOne(["소개팅","썸","카톡","남친","여친"])} ${pickOne(["읽씹","잠수","환승","정떨어짐","서운함"])} 썰`, tag: "연애" },
        { t: `${pickOne(["기념일","선물","프사","연락"])} 때문에 싸운 썰`, tag: "연애" },
        { t: `연애하다 ${pickOne(["정떨어진","현타온","충격받은"])} 순간`, tag: "연애" },
      );
    }

    if (isWork) {
      templates.push(
        { t: `회식에서 ${pickOne(["상사","팀장","사장"])} 한마디 레전드`, tag: "직장" },
        { t: `${pickOne(["막내","신입","인턴"])}가 만든 분위기 반전`, tag: "직장" },
        { t: `퇴사 통보했더니 ${pickOne(["반응","태도","말"])}가…`, tag: "직장" },
      );
    }

    if (isDaily) {
      templates.push(
        { t: `${pickOne(["중고거래","택시","카페","헬스장","술자리","친구"])}에서 만난 빌런`, tag: "일상" },
        { t: `${pickOne(["무단횡단","배달","이웃","모임","축의금"])} 때문에 생긴 일`, tag: "일상" },
        { t: `${pickOne(["민망한","충격","사이다","반전"])} 일상 썰`, tag: "일상" },
      );
    }

    if (baseFit >= 45) {
      templates.push({ t: `${raw} 썰`, tag: isRomance ? "연애" : isWork ? "직장" : "일상" });
      if (raw.length <= 8) templates.push({ t: `${raw} 레전드`, tag: isRomance ? "연애" : isWork ? "직장" : "일상" });
    }

    for (const tp of templates) {
      const term = normalizeStoryTerm(tp.t);
      if (!term) continue;

      const storyFitScore = clampInt(baseFit + (tp.tag === "연애" ? 15 : 0) + (tp.t.includes("썰") ? 10 : 0), 0, 100);
      const freshnessScore = fresh;
      const preScore = Math.round(storyFitScore * 0.55 + freshnessScore * 0.25 + clampInt(w / 8, 0, 100) * 0.20);

      add({
        term,
        searchTerm: toSearchTerm(term),
        tags: Array.from(new Set([tp.tag, baseFit >= 55 ? "핵심" : "확장"])),
        storyFitScore,
        freshnessScore,
        preScore,
        rawSeed: raw,
        sources: srcs,
        related: makeDefaultRelated(term),
        demandScore: 0,
      });
    }
  }

  return Array.from(candidates.values());
}

function normalizeStoryTerm(s) {
  if (!s) return "";
  let t = sanitizeText(String(s)).trim();
  t = t.replace(/\s+/g, " ");
  if (t.length > 28) t = t.slice(0, 28).trim();
  t = t.replace(/(때문에)$/g, "때문");
  if (t.includes("�")) return "";
  return t;
}
function toSearchTerm(term) {
  let t = sanitizeText(String(term || ""));
  t = t.replace(/[“”"']/g, "");
  t = t.replace(/\s+/g, " ").trim();
  if (t.length > 24) t = t.slice(0, 24).trim();
  return t;
}
function pickOne(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// YouTube Suggest (ds=yt)
async function fetchYouTubeSuggest(query, { geo = "KR", hl = "ko" } = {}) {
  const q = sanitizeText(String(query || "")).trim();
  if (!q) return [];
  const key = `ytSuggest:${geo}:${hl}:${q.toLowerCase()}`;
  const cached = memGet(key, 6 * 60 * 60 * 1000);
  if (cached) return cached;

  const url =
    "https://suggestqueries.google.com/complete/search" +
    `?client=firefox&ds=yt&hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(geo)}&q=${encodeURIComponent(q)}`;

  const r = await fetchJson(url, {
    timeoutMs: 8000,
    headers: {
      "User-Agent": "trends-proxy/1.0 (personal use)",
      "Accept": "application/json,text/plain,*/*",
    },
  });

  if (!r.ok || !Array.isArray(r.json)) return [];

  const suggestions = Array.isArray(r.json[1]) ? r.json[1].map((x) => sanitizeText(String(x))) : [];
  const cleaned = suggestions
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !s.includes("�"))
    .slice(0, 20);

  memSet(key, cleaned);
  return cleaned;
}

async function enrichWithYouTubeSuggest(items, { geo, hl, debug }) {
  const concurrency = 6;
  let idx = 0;
  const results = new Array(items.length);

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      const it = items[i];
      const baseQuery = suggestQueryFromTerm(it.searchTerm || it.term);

      try {
        const sugg = await fetchYouTubeSuggest(baseQuery, { geo, hl });
        const demandScore = scoreDemandFromSuggest(baseQuery, sugg, it);
        const related = mergeRelated(it.related, sugg, it.term);

        results[i] = {
          ...it,
          demandScore,
          related,
          tags: strengthenTags(it.tags, it.term, sugg),
        };
      } catch (e) {
        debug?.errors?.push({ step: "ytSuggest", term: it.term, error: e?.message || String(e) });
        results[i] = {
          ...it,
          demandScore: clampInt(25 + it.storyFitScore * 0.35, 0, 100),
          related: it.related,
        };
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  debug.steps.ytSuggestChecked = items.length;
  return results.filter(Boolean);
}

function suggestQueryFromTerm(term) {
  let t = sanitizeText(String(term || "")).trim();
  t = t.replace(/\s*레전드\s*/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  if (t.length > 16) t = t.slice(0, 16).trim();
  return t;
}

function scoreDemandFromSuggest(query, sugg, it) {
  const list = Array.isArray(sugg) ? sugg : [];
  const count = list.length;

  const tails = new Set();
  for (const s of list) {
    const rest = sanitizeText(String(s)).replace(query, "").trim();
    if (rest) tails.add(rest.split(" ")[0]);
  }
  const diversity = tails.size;

  let base = 0;
  base += Math.min(60, count * 4.2);
  base += Math.min(25, diversity * 4.5);

  const romanceBoost = hasAny(it.term, TRIG_ROMANCE) ? 10 : 0;
  const dailyBoost = hasAny(it.term, TRIG_DAILY) ? 6 : 0;
  const workBoost = hasAny(it.term, TRIG_WORK) ? 5 : 0;
  const emoBoost = hasAny(it.term, EMO_TRIG) ? 8 : 0;

  return clampInt(Math.round(base + romanceBoost + dailyBoost + workBoost + emoBoost), 0, 100);
}

function mergeRelated(defaultRel, sugg, term) {
  const rel = new Set((defaultRel || []).map((x) => sanitizeText(String(x))));
  for (const s of (sugg || []).slice(0, 12)) {
    const v = sanitizeText(String(s)).trim();
    if (!v || v.includes("�")) continue;
    rel.add(v);
  }
  rel.add(`${term} 공감`);
  rel.add(`${term} 사이다`);
  rel.add(`${term} 반전`);
  return cleanArrayStrings(Array.from(rel), "ko", 12);
}

function strengthenTags(tags, term, sugg) {
  const set = new Set((tags || []).map((x) => sanitizeText(String(x))));
  if (hasAny(term, TRIG_ROMANCE)) set.add("연애");
  if (hasAny(term, TRIG_WORK)) set.add("직장");
  if (hasAny(term, TRIG_DAILY)) set.add("일상");
  if (hasAny(term, EMO_TRIG)) set.add("감정");
  if ((sugg || []).length >= 10) set.add("수요높음");
  return Array.from(set).slice(0, 6);
}

/* -----------------------
 * Reddit (RSS only)
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

  const items = top.map(({ term, count }) => {
    const base = Math.max(25, count * 18);
    const series = synthSeries(n, base);
    return {
      term,
      series,
      score: scoreFromSeries(series),
      tags: ["reddit"],
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
      keywordsAreLive: true,
      note: "Reddit RSS 제목 토큰 빈도 기반 근사",
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

  const titles = (r.json.items || []).map((it) => sanitizeText(String(it?.snippet?.title || ""))).filter(Boolean);
  const { top, relatedList } = deriveFromTitles(titles, hl, 80);

  const items = top.map(({ term, count }) => {
    const base = Math.max(30, count * 22);
    const series = synthSeries(n, base);
    return {
      term,
      series,
      score: scoreFromSeries(series),
      tags: ["youtube"],
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
      keywordsAreLive: true,
      note: "YouTube MostPopular 제목 토큰 빈도 기반 근사",
      fetchedAt: nowIso(),
    },
  };
}

/* -----------------------
 * Google Trends RSS
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
      tags: ["trends"],
      related: makeDefaultRelated(term),
      links: makeLinks(term, geo, hl),
    };
  });

  return {
    items: topN(items, 20),
    meta: {
      source: "googleTrends",
      isMock: false,
      seriesIsSynthetic: true,
      keywordsAreLive: true,
      note: "Google Trends realtime RSS 기반 (차트는 근사)",
      fetchedAt: nowIso(),
    },
  };
}

/* -----------------------
 * Google News RSS
 * ---------------------- */
async function fromGoogleNewsRss({ tf, geo, hl }) {
  const n = bucketCount(tf);

  const ceid = `${geo}:${hl}`;
  const url = `https://news.google.com/rss?hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(geo)}&ceid=${encodeURIComponent(ceid)}`;

  const r = await fetchText(url, { timeoutMs: 9000, headers: { "User-Agent": "trends-proxy/1.0" } });
  if (!r.ok || !r.text) throw new Error("Google News RSS fetch 실패: " + r.status);

  const titlesRaw = parseFeedTitles(r.text).slice(0, 120);
  const titles = titlesRaw.map((t) => sanitizeText(String(t).split(" - ")[0]));

  const { top, relatedList } = deriveFromTitles(titles, hl, 80);

  const items = top.map(({ term, count }) => {
    const base = Math.max(30, count * 25);
    const series = synthSeries(n, base);
    return {
      term,
      series,
      score: scoreFromSeries(series),
      tags: ["news"],
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
      keywordsAreLive: true,
      note: "Google News RSS 제목 토큰 빈도 기반 근사",
      fetchedAt: nowIso(),
    },
  };
}

/* -----------------------
 * HackerNews
 * ---------------------- */
async function fromHackerNews({ tf, geo, hl }) {
  const n = bucketCount(tf);
  const r = await fetchJson("https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=80", { timeoutMs: 9000 });
  if (!r.ok || !r.json) throw new Error("HN fetch 실패: " + r.status);

  const titles = (r.json.hits || []).map((h) => sanitizeText(String(h?.title || ""))).filter(Boolean);
  const { top, relatedList } = deriveFromTitles(titles, "en", 80);

  const items = top.map(({ term, count }) => {
    const base = Math.max(30, count * 20);
    const series = synthSeries(n, base);
    return {
      term,
      series,
      score: scoreFromSeries(series),
      tags: ["hackernews"],
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
      keywordsAreLive: true,
      note: "HN 제목 토큰 빈도 기반 근사",
      fetchedAt: nowIso(),
    },
  };
}

/* -----------------------
 * Naver DataLab (검증용)
 * ---------------------- */
// 아래는 네 기존 코드 그대로 유지(이미 JSON이라 인코딩 깨짐 거의 없음)
async function fromNaverDataLabDiscover({ tf, geo, hl, clientId, clientSecret }) {
  const n = bucketCount(tf);

  const maxCandidates = clampInt(process.env.NAVER_CANDIDATES || 35, 10, 60);
  const candidates = await gatherCandidates({ geo, hl, maxCandidates });

  const seedsEnv = (process.env.NAVER_SEEDS || "").toString().trim();
  const seeds = seedsEnv ? seedsEnv.split(",").map((s) => s.trim()).filter(Boolean) : [];

  const finalCandidates = Array.from(new Set([...candidates, ...seeds])).slice(0, maxCandidates);

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
      const term = sanitizeText(String(rs.title || rs.keyword || "")).trim();
      const raw = (rs.data || []).map((d) => Number(d.ratio || 0));
      if (!term || raw.length === 0) continue;

      let series;
      if (tf === "hour") {
        const base = raw[raw.length - 1] || 10;
        series = synthSeries(n, Math.max(10, Math.round(base * 10)));
      } else {
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
      tags: ["naver"],
      related: makeDefaultRelated(term),
      links: makeLinks(term, geo, hl),
    });
  }

  return {
    items: topN(items, 20),
    meta: {
      source: "naver",
      isMock: false,
      seriesIsSynthetic: true,
      keywordsAreLive: true,
      note: "후보 자동 수집 → Naver DataLab 가속도 리랭킹 TOP20",
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
    const term = normalizeKoreanTerm(t);
    if (!term) return;
    if (hl === "ko" && !/[가-힣]/.test(term)) return;
    out.push(term);
  };

  try {
    const url = `https://trends.google.com/trends/trendingsearches/realtime/rss?geo=${encodeURIComponent(geo)}&category=all`;
    const r = await fetchText(url, { timeoutMs: 9000, headers: { "User-Agent": "trends-proxy/1.0" } });
    if (r.ok && r.text) parseFeedTitles(r.text).slice(0, 60).forEach(add);
  } catch {}

  try {
    const ceid = `${geo}:${hl}`;
    const url = `https://news.google.com/rss?hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(geo)}&ceid=${encodeURIComponent(ceid)}`;
    const r = await fetchText(url, { timeoutMs: 9000, headers: { "User-Agent": "trends-proxy/1.0" } });
    if (r.ok && r.text) {
      const titles = parseFeedTitles(r.text).slice(0, 120).map((t) => String(t).split(" - ")[0]);
      const { top } = deriveFromTitles(titles, hl, 60);
      top.forEach((x) => add(x.term));
    }
  } catch {}

  const uniq = Array.from(new Set(out));
  return uniq.slice(0, maxCandidates);
}

function naverDateRange(timeUnit, tf) {
  const end = new Date();
  const endDate = toYmd(end);

  const start = new Date(end);
  if (timeUnit === "date") start.setDate(start.getDate() - 6);
  else if (timeUnit === "week") start.setDate(start.getDate() - (8 * 7 - 1));
  else start.setMonth(start.getMonth() - 11);

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
