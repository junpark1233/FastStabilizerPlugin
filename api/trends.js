// /api/trends.js
// Vercel Serverless Function
// 핵심 목표
// 1) source=interestKR: 최근 관심 키워드 후보를 "대량(기본 2000, 최대 5000)"으로 만들어 내려줌
// 2) 각 키워드에 grade(0~100) 등급 부여 (rank 기반, 분포가 고르게 나오게)
// 3) 프론트는 grade 클릭 -> 해당 등급 키워드 최대 100개 표시
// 4) mock 키워드 생성은 하지 않음 (실패 시 stale 캐시 or 에러)

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  // CDN cache (호출수 절감)
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');

  const startedAt = Date.now();

  try {
    const source = normalizeSource((req.query.source ?? 'interestKR').toString());
    const tf = normalizeTf(((req.query.tf ?? req.query.timeframe ?? 'hour') || 'hour').toString());
    const geo = (((req.query.geo ?? req.query.country ?? 'KR') || 'KR').toString()).toUpperCase();
    const hl = (((req.query.hl ?? req.query.lang ?? 'ko') || 'ko').toString()).toLowerCase();
    const cat = ((req.query.cat ?? 'all') || 'all').toString();
    const q = ((req.query.q ?? '') || '').toString().trim();

    const limit = clampInt(req.query.limit ?? process.env.INTEREST_LIMIT ?? 2000, 200, 5000);

    // cache key (q는 필터이므로 key에 포함)
    const cacheKey = JSON.stringify({ source, tf, geo, hl, cat, q, limit, seeds: (req.query.seeds ?? ''), seedMode: (req.query.seedMode ?? ''), expand: (req.query.expand ?? '') });

    const fresh = memGet(cacheKey, 60_000);
    if (fresh) return res.status(200).json(withMeta(fresh, { tookMs: Date.now() - startedAt }));

    const stale = memGetAny(cacheKey);

    let payload;
    try {
      payload = await dispatchProvider({ source, tf, geo, hl, cat, limit, reqQuery: req.query });
    } catch (err) {
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
        return res.status(503).json({
          error: 'provider_failed',
          message: err?.message || String(err),
          meta: { source, tf, geo, hl, tookMs: Date.now() - startedAt, fetchedAt: nowIso() },
        });
      }
    }

    // 서버측 q 필터
    if (q && Array.isArray(payload?.items)) {
      const qq = q.toLowerCase();
      payload.items = payload.items.filter((x) => String(x.term || '').toLowerCase().includes(qq));
    }

    payload = withMeta(payload, { tookMs: Date.now() - startedAt });

    memSet(cacheKey, payload);
    memSetAny(cacheKey, payload);

    return res.status(200).json(payload);
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: e?.message || String(e), fetchedAt: nowIso() });
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
  const x = String(s || '').toLowerCase();
  if (x === 'interestkr' || x.includes('interest')) return 'interestKR';
  if (x === 'storykr' || x.includes('story')) return 'storyKR';
  if (x.includes('youtube')) return 'youtube';
  if (x.includes('naver')) return 'naver';
  if (x.includes('reddit')) return 'reddit';
  if (x.includes('trend')) return 'googleTrends';
  if (x === 'news' || x.includes('googlenews')) return 'news';
  if (x.includes('hacker')) return 'hackernews';
  return x;
}
function normalizeTf(tf) {
  const t = String(tf || 'hour').toLowerCase();
  if (t.startsWith('h')) return 'hour';
  if (t.startsWith('d')) return 'day';
  if (t.startsWith('w')) return 'week';
  if (t.startsWith('m')) return 'month';
  return 'hour';
}
function bucketCount(tf) {
  if (tf === 'hour') return 24;
  if (tf === 'day') return 7;
  if (tf === 'week') return 8;
  if (tf === 'month') return 12;
  return 24;
}
function nowIso() {
  return new Date().toISOString();
}
function clampInt(n, min, max) {
  const x = Number.isFinite(+n) ? +n : min;
  return Math.min(max, Math.max(min, x));
}

/* -----------------------
 * Provider dispatcher
 * ---------------------- */
async function dispatchProvider({ source, tf, geo, hl, cat, limit, reqQuery }) {
  if (source === 'interestKR') return fromInterestKR({ tf, geo, hl, limit, reqQuery });

  // 아래 소스들은 "TOP20" 성격(참고용)
  if (source === 'googleTrends') return fromGoogleTrendsRss({ tf, geo, hl, cat });
  if (source === 'news') return fromGoogleNewsRss({ tf, geo, hl });
  if (source === 'reddit') return fromRedditRssOnly({ tf, geo, hl });
  if (source === 'hackernews') return fromHackerNews({ tf, geo, hl });

  if (source === 'youtube') {
    const key = process.env.YT_KEY || process.env.YOUTUBE_API_KEY;
    if (!key) throw new Error('YT_KEY/YOUTUBE_API_KEY 없음');
    return fromYouTubeMostPopular({ tf, geo, hl, key });
  }

  if (source === 'naver') {
    const id = process.env.NAVER_CLIENT_ID;
    const secret = process.env.NAVER_CLIENT_SECRET;
    if (!id || !secret) throw new Error('NAVER_CLIENT_ID/SECRET 없음');
    return fromNaverDataLabDiscover({ tf, geo, hl, clientId: id, clientSecret: secret });
  }

  // storyKR는 interestKR 다음 단계용으로 남겨둠
  if (source === 'storyKR') return fromStoryKR({ tf, geo, hl });

  throw new Error(`unknown source: ${source}`);
}

/* -----------------------
 * Fetch helpers
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

/* -----------------------
 * RSS/Atom parsing
 * ---------------------- */
function decodeXml(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}
function stripHtml(s) {
  return String(s).replace(/<[^>]+>/g, '');
}
function parseFeedTitles(xmlText) {
  if (!xmlText || typeof xmlText !== 'string') return [];
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

  return titles;
}

/* -----------------------
 * Tokenization + scoring
 * ---------------------- */
function buildStop(hl) {
  const en = [
    'the','a','an','and','or','to','of','in','on','for','with','is','are','was','were','be','from',
    'vs','ver','feat','official','mv','teaser','trailer','full','live','episode','ep','part',
    'new','update','today','breaking','what','why','how','when','where','who',
  ];
  const ko = [
    '영상','공식','라이브','뮤비','예고','티저','하이라이트','리뷰','반응','요약','뉴스','속보','단독',
    '오늘','지금','최신','화제','사건','사고','인터뷰','출연','공개','발표','논란','정리','추측',
    '기자','보도','관련','논의','확인','전문','분석',
  ];
  const set = new Set();
  for (const w of en) set.add(w);
  for (const w of ko) set.add(w);
  return set;
}

function looksBroken(s) {
  const t = String(s || '');
  if (!t) return true;
  if (t.includes('�')) return true;
  if (/\uFFFD/.test(t)) return true;
  // 너무 특수문자 비율이 높으면 제거
  const cleaned = t.replace(/[\p{L}\p{N}\s]/gu, '');
  if (cleaned.length >= Math.max(4, t.length * 0.45)) return true;
  return false;
}

function tokenizeOrdered(text, hl) {
  const s = String(text || '');
  const stop = buildStop(hl);

  // 한글 단어: 공백 기준
  const hangulWords = (s.match(/[가-힣0-9]+/g) || [])
    .map((x) => x.trim())
    .filter((x) => x.length >= 2);

  // 영어/숫자 단어
  const latinWords = s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .filter((x) => x.length >= 2);

  const out = [];
  for (const w of hangulWords) {
    if (/^\d+$/.test(w)) continue;
    if (stop.has(w)) continue;
    out.push(w);
  }
  for (const w of latinWords) {
    if (/^\d+$/.test(w)) continue;
    if (stop.has(w)) continue;
    out.push(w);
  }

  // 중복 제거는 유지하되 "순서"는 대체로 살리기 위해 첫 등장만 유지
  const seen = new Set();
  const ordered = [];
  for (const w of out) {
    if (seen.has(w)) continue;
    seen.add(w);
    ordered.push(w);
  }
  return ordered;
}

function extractPhrases(title, hl) {
  // unigram + bigram + trigram (길이 제한)
  const toks = tokenizeOrdered(title, hl);
  const phrases = [];
  for (const t of toks) phrases.push({ p: t, mult: 1.0 });

  for (let i = 0; i < toks.length - 1; i++) {
    const p = `${toks[i]} ${toks[i + 1]}`;
    if (p.length <= 26) phrases.push({ p, mult: 1.35 });
  }
  for (let i = 0; i < toks.length - 2; i++) {
    const p = `${toks[i]} ${toks[i + 1]} ${toks[i + 2]}`;
    if (p.length <= 30) phrases.push({ p, mult: 1.55 });
  }

  return phrases;
}

function normalizeTerm(term) {
  let t = String(term || '').trim();
  t = t.replace(/\s+/g, ' ');
  t = t.replace(/[\[\]{}()<>【】]/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  // 뒤에 너무 흔한 꼬리 제거
  t = t.replace(/\s*\-\s*$/g, '');
  if (t.length < 2) return '';
  if (looksBroken(t)) return '';
  return t;
}

function makeLinks(term, geo, hl) {
  return {
    youtube: 'https://www.youtube.com/results?search_query=' + encodeURIComponent(term),
    naver: 'https://search.naver.com/search.naver?query=' + encodeURIComponent(term),
    google: 'https://www.google.com/search?q=' + encodeURIComponent(term),
    news: 'https://news.google.com/search?q=' + encodeURIComponent(term) + `&hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(geo)}`,
  };
}

function computeGradeByRank(rank, n) {
  if (n <= 1) return 100;
  const g = Math.round(100 - ((rank - 1) * 100) / (n - 1));
  return clampInt(g, 0, 100);
}

/* -----------------------
 * interestKR: 대량 관심 키워드 생성
 * ---------------------- */
async function fromInterestKR({ tf, geo, hl, limit, reqQuery }) {
  const started = Date.now();

  const seedMode = String(reqQuery.seedMode || 'replace').toLowerCase(); // replace|merge
  const customSeeds = parseSeeds(reqQuery.seeds || '');

  const defaultSeeds = getDefaultSeedsKR();
  const seedsUsed = (customSeeds.length === 0)
    ? defaultSeeds
    : (seedMode === 'merge' ? uniq([...defaultSeeds, ...customSeeds]) : customSeeds);

  // 너무 많은 호출 방지
  const maxSeedCalls = clampInt(reqQuery.maxSeeds ?? process.env.INTEREST_MAX_SEEDS ?? 24, 8, 40);
  const seeds = seedsUsed.slice(0, maxSeedCalls);

  // 확장(옵션): seed로 YouTube suggest 확장 (기본 off: 안정성)
  const expand = String(reqQuery.expand || '').toLowerCase(); // 'yt'

  const debug = { seedsUsed: seeds, maxSeeds: maxSeedCalls, expand, steps: {}, errors: [] };

  // 1) Trends realtime terms
  const sourceWeights = {
    trends: 3.2,
    newsSearch: 1.6,
    newsHome: 1.2,
    ytSuggest: 0.9,
  };

  const score = new Map(); // term -> { score, sources:Set }
  const addScore = (term, w, src) => {
    const t = normalizeTerm(term);
    if (!t) return;
    const v = score.get(t) || { score: 0, sources: new Set() };
    v.score += w;
    v.sources.add(src);
    score.set(t, v);
  };

  // 1-a) Trends RSS
  try {
    const url = `https://trends.google.com/trends/trendingsearches/realtime/rss?geo=${encodeURIComponent(geo)}&category=all`;
    const r = await fetchText(url, { timeoutMs: 9000, headers: { 'User-Agent': 'trends-proxy/interestKR' } });
    if (r.ok && r.text) {
      const terms = parseFeedTitles(r.text).slice(0, 200);
      debug.steps.trendsCount = terms.length;
      // 상위일수록 가중치
      const L = Math.max(1, terms.length);
      terms.forEach((t, i) => {
        const posW = (L - i) / L; // 1..0
        const w = 1000 * posW * sourceWeights.trends;
        addScore(t, w, 'trends');
      });
    } else {
      debug.errors.push({ step: 'trends', status: r.status });
    }
  } catch (e) {
    debug.errors.push({ step: 'trends', error: e?.message || String(e) });
  }

  // 1-b) Google News 홈 RSS (추가 신호)
  try {
    const ceid = `${geo}:${hl}`;
    const url = `https://news.google.com/rss?hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(geo)}&ceid=${encodeURIComponent(ceid)}`;
    const r = await fetchText(url, { timeoutMs: 9000, headers: { 'User-Agent': 'trends-proxy/interestKR' } });
    if (r.ok && r.text) {
      const titles = parseFeedTitles(r.text).slice(0, 200).map((t) => String(t).split(' - ')[0]);
      debug.steps.newsHomeTitles = titles.length;
      const L = Math.max(1, titles.length);
      titles.forEach((title, idx) => {
        const posW = (L - idx) / L;
        const phrases = extractPhrases(title, hl);
        for (const { p, mult } of phrases) {
          addScore(p, 90 * posW * mult * sourceWeights.newsHome, 'news');
        }
      });
    } else {
      debug.errors.push({ step: 'newsHome', status: r.status });
    }
  } catch (e) {
    debug.errors.push({ step: 'newsHome', error: e?.message || String(e) });
  }

  // 2) Seed 기반 Google News RSS Search
  const titlesForRelated = [];
  const seedFetchConcurrency = 6;
  let si = 0;
  debug.steps.seedCount = seeds.length;

  async function seedWorker() {
    while (si < seeds.length) {
      const i = si++;
      const seed = seeds[i];
      const url = buildGoogleNewsSearchRssUrl(seed, { geo, hl });
      try {
        const r = await fetchText(url, { timeoutMs: 9000, headers: { 'User-Agent': 'trends-proxy/interestKR' } });
        if (r.ok && r.text) {
          const titles = parseFeedTitles(r.text).slice(0, 120).map((t) => String(t).split(' - ')[0]);
          titlesForRelated.push(...titles);
          const L = Math.max(1, titles.length);
          titles.forEach((title, idx) => {
            const posW = (L - idx) / L;
            const phrases = extractPhrases(title, hl);
            for (const { p, mult } of phrases) {
              // seed 검색결과는 seed 자체와 가까운 문맥 -> weight 조금 상향
              const w = 130 * posW * mult * sourceWeights.newsSearch;
              addScore(p, w, `seed:${seed}`);
            }
          });
        } else {
          debug.errors.push({ step: 'newsSearch', seed, status: r.status });
        }
      } catch (e) {
        debug.errors.push({ step: 'newsSearch', seed, error: e?.message || String(e) });
      }

      // 옵션: YouTube suggest로 확장 (불안정할 수 있어 옵션)
      if (expand === 'yt') {
        try {
          const sugg = await fetchYouTubeSuggest(seed, { geo, hl });
          debug.steps.ytSuggest = (debug.steps.ytSuggest || 0) + 1;
          for (let k = 0; k < Math.min(25, sugg.length); k++) {
            const s = sugg[k];
            const w = 90 * (1 - k / 25) * sourceWeights.ytSuggest;
            addScore(s, w, 'ytSuggest');
          }
        } catch (e) {
          debug.errors.push({ step: 'ytSuggest', seed, error: e?.message || String(e) });
        }
      }
    }
  }

  await Promise.all(Array.from({ length: seedFetchConcurrency }, () => seedWorker()));

  debug.steps.totalCandidates = score.size;

  // 3) 후보 정렬 -> 상위 limit
  const entries = Array.from(score.entries())
    .map(([term, v]) => ({ term, scoreRaw: v.score, sources: Array.from(v.sources) }))
    .filter((x) => x.term.length >= 2)
    .filter((x) => !looksBroken(x.term));

  if (entries.length < 200) {
    throw new Error('interestKR 수집량이 너무 적습니다 (네트워크/차단 가능).');
  }

  entries.sort((a, b) => b.scoreRaw - a.scoreRaw);
  const top = entries.slice(0, limit);

  // 관련어: 타이틀 기반 unigram co-occurrence 근사
  const { relatedList } = deriveFromTitlesForRelated(titlesForRelated, hl);

  const items = top.map((x, idx) => {
    const rank = idx + 1;
    const grade = computeGradeByRank(rank, top.length);
    const related = pickRelatedForTerm(x.term, relatedList, hl);

    // sparkline은 "표시용" (키워드 자체는 live)
    const series = synthSeries(bucketCount(tf), Math.max(15, Math.round(x.scoreRaw / 6)));

    return {
      rank,
      grade,
      term: x.term,
      scoreRaw: Math.round(x.scoreRaw),
      sources: x.sources.slice(0, 6),
      series,
      related,
      links: makeLinks(x.term, geo, hl),
    };
  });

  return {
    items,
    meta: {
      source: 'interestKR',
      isMock: false,
      keywordsAreLive: true,
      seriesIsSynthetic: true,
      note: 'Google Trends RSS + Google News RSS(Search) 다중 수집 기반 대량 키워드 (rank->grade 버킷)',
      geo,
      hl,
      tf,
      limit,
      fetchedAt: nowIso(),
      tookMs: Date.now() - started,
      debug,
    },
  };
}

function parseSeeds(seedsStr) {
  const s = String(seedsStr || '').trim();
  if (!s) return [];
  return uniq(
    s
      .split(/[,\n\r\t]+/)
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 200)
  );
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

function getDefaultSeedsKR() {
  // "전분야" 관심사 뽑기용 (연애/일상 포함 + 뉴스/생활/엔터/경제/건강)
  return [
    '연애','이별','소개팅','썸','결혼','동거','카톡','프사','기념일','선물',
    '직장','회식','상사','퇴사','연봉','면접','취업','인턴','부동산','전세',
    '주식','코인','비트코인','환율','금리','경제','물가','세금','청약','대출',
    '다이어트','헬스','건강','피부','수면','우울','스트레스','습관','루틴','운동',
    '아이폰','갤럭시','유튜브','넷플릭스','드라마','예능','영화','아이돌','K팝','콘서트',
    '축구','야구','경기','게임','스팀','롤','메이플','여행','맛집','카페',
    '사건','사고','범죄','정치','논란','학교','교육','자격증','육아','반려동물',
  ];
}

function buildGoogleNewsSearchRssUrl(seed, { geo, hl }) {
  const ceid = `${geo}:${hl}`;
  const q = encodeURIComponent(seed);
  return `https://news.google.com/rss/search?q=${q}&hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(geo)}&ceid=${encodeURIComponent(ceid)}`;
}

// deriveFromTitles (related only) - 가볍게
function deriveFromTitlesForRelated(titles, hl) {
  const related = new Map();
  for (const title of (titles || []).slice(0, 2500)) {
    const toks = tokenizeOrdered(title, hl);
    const uniqToks = Array.from(new Set(toks));
    for (let i = 0; i < uniqToks.length; i++) {
      const a = uniqToks[i];
      if (!related.has(a)) related.set(a, new Map());
      const m = related.get(a);
      for (let j = 0; j < uniqToks.length; j++) {
        if (i === j) continue;
        const b = uniqToks[j];
        m.set(b, (m.get(b) || 0) + 1);
      }
    }
  }

  const relatedList = (term) => {
    const m = related.get(term);
    if (!m) return [];
    return Array.from(m.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([t]) => t);
  };

  return { relatedList };
}

function pickRelatedForTerm(term, relatedList, hl) {
  const t = String(term || '').trim();
  if (!t) return [];

  // multi-word면 마지막 토큰을 우선
  if (t.includes(' ')) {
    const parts = t.split(' ').filter(Boolean);
    const base = parts[parts.length - 1];
    const rel = relatedList(base);
    return uniq([`${t} 검색`, ...rel]).slice(0, 12);
  }

  const rel = relatedList(t);
  if (rel.length) return rel.slice(0, 12);

  // fallback
  return uniq([`${t} 뜻`, `${t} 이유`, `${t} 후기`, `${t} 사건`]).slice(0, 8);
}

/* -----------------------
 * Optional sources (참고용)
 * ---------------------- */

// Reddit (RSS only)
async function fromRedditRssOnly({ tf, geo, hl }) {
  const n = bucketCount(tf);
  const subsEnv = (process.env.REDDIT_SUBS || 'worldnews,technology,programming,korea').toString();
  const subs = subsEnv.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 12);

  const titles = [];
  const errors = [];

  for (const sub of subs) {
    const url = `https://www.reddit.com/r/${encodeURIComponent(sub)}/hot.rss`;
    const r = await fetchText(url, {
      timeoutMs: 9000,
      headers: {
        'User-Agent': 'trends-proxy/1.0 (personal use)',
        'Accept': 'application/rss+xml, application/atom+xml, text/xml;q=0.9, */*;q=0.8',
      },
    });

    if (r.ok && r.text) {
      const t = parseFeedTitles(r.text);
      for (const x of t) titles.push(x);
    } else {
      errors.push({ sub, rssStatus: r.status });
    }
  }

  if (titles.length < 5) throw new Error('reddit RSS 결과 부족');

  const { top, relatedList } = deriveFromTitles(titles, hl, 80);

  const items = top.map(({ term, count }) => {
    const base = Math.max(25, count * 18);
    const series = synthSeries(n, base);
    return {
      term,
      scoreRaw: base,
      grade: 0,
      series,
      related: relatedList(term).slice(0, 8),
      links: makeLinks(term, geo, hl),
    };
  });

  return {
    items: items.slice(0, 50).map((x, i) => ({ ...x, rank: i + 1, grade: computeGradeByRank(i + 1, Math.min(50, items.length)) })),
    meta: {
      source: 'reddit',
      isMock: false,
      keywordsAreLive: true,
      seriesIsSynthetic: true,
      note: 'Reddit RSS 제목 토큰 빈도 기반 근사',
      fetchedAt: nowIso(),
      debug: errors.length ? { errors } : undefined,
    },
  };
}

// YouTube MostPopular
async function fromYouTubeMostPopular({ tf, geo, hl, key }) {
  const n = bucketCount(tf);

  const url = new URL('https://www.googleapis.com/youtube/v3/videos');
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('chart', 'mostPopular');
  url.searchParams.set('maxResults', '50');
  url.searchParams.set('regionCode', geo || 'KR');
  url.searchParams.set('key', key);

  const r = await fetchJson(url.toString(), { timeoutMs: 9000 });
  if (!r.ok || !r.json) throw new Error('YouTube fetch 실패: ' + r.status);

  const titles = (r.json.items || []).map((it) => String(it?.snippet?.title || '')).filter(Boolean);
  const { top, relatedList } = deriveFromTitles(titles, hl, 120);

  const items = top.map(({ term, count }) => {
    const base = Math.max(30, count * 22);
    const series = synthSeries(n, base);
    return {
      term,
      series,
      scoreRaw: base,
      related: relatedList(term).slice(0, 8),
      links: makeLinks(term, geo, hl),
    };
  });

  const sliced = items.slice(0, 60);
  return {
    items: sliced.map((x, i) => ({ ...x, rank: i + 1, grade: computeGradeByRank(i + 1, sliced.length) })),
    meta: {
      source: 'youtube',
      isMock: false,
      keywordsAreLive: true,
      seriesIsSynthetic: true,
      note: 'YouTube MostPopular 제목 토큰 기반',
      fetchedAt: nowIso(),
    },
  };
}

// Google Trends RSS
async function fromGoogleTrendsRss({ tf, geo, hl, cat }) {
  const n = bucketCount(tf);
  const category = cat && cat !== 'all' ? cat : 'all';
  const url = `https://trends.google.com/trends/trendingsearches/realtime/rss?geo=${encodeURIComponent(geo)}&category=${encodeURIComponent(category)}`;

  const r = await fetchText(url, { timeoutMs: 9000, headers: { 'User-Agent': 'trends-proxy/1.0' } });
  if (!r.ok || !r.text) throw new Error('Google Trends RSS fetch 실패: ' + r.status);

  const terms = parseFeedTitles(r.text).slice(0, 120);
  if (terms.length < 3) throw new Error('trends rss 파싱 실패');

  const items = terms.map((term, idx) => {
    const base = Math.max(30, 220 - idx * 2 + Math.floor(Math.random() * 10));
    const series = synthSeries(n, base);
    return {
      term,
      series,
      scoreRaw: base,
      related: [],
      links: makeLinks(term, geo, hl),
    };
  });

  const sliced = items.slice(0, 80);
  return {
    items: sliced.map((x, i) => ({ ...x, rank: i + 1, grade: computeGradeByRank(i + 1, sliced.length) })),
    meta: {
      source: 'googleTrends',
      isMock: false,
      keywordsAreLive: true,
      seriesIsSynthetic: true,
      note: 'Google Trends realtime RSS',
      fetchedAt: nowIso(),
    },
  };
}

// Google News RSS
async function fromGoogleNewsRss({ tf, geo, hl }) {
  const n = bucketCount(tf);

  const ceid = `${geo}:${hl}`;
  const url = `https://news.google.com/rss?hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(geo)}&ceid=${encodeURIComponent(ceid)}`;

  const r = await fetchText(url, { timeoutMs: 9000, headers: { 'User-Agent': 'trends-proxy/1.0' } });
  if (!r.ok || !r.text) throw new Error('Google News RSS fetch 실패: ' + r.status);

  const titlesRaw = parseFeedTitles(r.text).slice(0, 200);
  const titles = titlesRaw.map((t) => String(t).split(' - ')[0]);

  const { top, relatedList } = deriveFromTitles(titles, hl, 120);

  const items = top.map(({ term, count }) => {
    const base = Math.max(30, count * 25);
    const series = synthSeries(n, base);
    return {
      term,
      series,
      scoreRaw: base,
      related: relatedList(term).slice(0, 8),
      links: makeLinks(term, geo, hl),
    };
  });

  const sliced = items.slice(0, 80);
  return {
    items: sliced.map((x, i) => ({ ...x, rank: i + 1, grade: computeGradeByRank(i + 1, sliced.length) })),
    meta: {
      source: 'news',
      isMock: false,
      keywordsAreLive: true,
      seriesIsSynthetic: true,
      note: 'Google News RSS 토큰 기반',
      fetchedAt: nowIso(),
    },
  };
}

// HackerNews
async function fromHackerNews({ tf, geo, hl }) {
  const n = bucketCount(tf);
  const r = await fetchJson('https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=80', { timeoutMs: 9000 });
  if (!r.ok || !r.json) throw new Error('HN fetch 실패: ' + r.status);

  const titles = (r.json.hits || []).map((h) => String(h?.title || '')).filter(Boolean);
  const { top, relatedList } = deriveFromTitles(titles, 'en', 120);

  const items = top.map(({ term, count }) => {
    const base = Math.max(30, count * 20);
    const series = synthSeries(n, base);
    return {
      term,
      series,
      scoreRaw: base,
      related: relatedList(term).slice(0, 8),
      links: makeLinks(term, geo, hl),
    };
  });

  const sliced = items.slice(0, 80);
  return {
    items: sliced.map((x, i) => ({ ...x, rank: i + 1, grade: computeGradeByRank(i + 1, sliced.length) })),
    meta: {
      source: 'hackernews',
      isMock: false,
      keywordsAreLive: true,
      seriesIsSynthetic: true,
      note: 'HN 토큰 기반',
      fetchedAt: nowIso(),
    },
  };
}

// deriveFromTitles (existing)
function deriveFromTitles(titles, hl, maxTerms = 80) {
  const freq = new Map();
  const related = new Map();

  for (const title of titles) {
    const toks = Array.from(new Set(tokenizeOrdered(title, hl)));
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

/* -----------------------
 * Display-only synthetic series
 * ---------------------- */
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

/* -----------------------
 * YouTube suggest (optional)
 * ---------------------- */
async function fetchYouTubeSuggest(query, { geo = 'KR', hl = 'ko' } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const key = `ytSuggest:${geo}:${hl}:${q.toLowerCase()}`;
  const cached = memGet(key, 6 * 60 * 60 * 1000);
  if (cached) return cached;

  const url =
    'https://suggestqueries.google.com/complete/search' +
    `?client=firefox&ds=yt&hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(geo)}&q=${encodeURIComponent(q)}`;

  const r = await fetchJson(url, {
    timeoutMs: 9000,
    headers: {
      'User-Agent': 'trends-proxy/1.0 (personal use)',
      'Accept': 'application/json,text/plain,*/*',
    },
  });

  if (!r.ok || !Array.isArray(r.json)) return [];

  const suggestions = Array.isArray(r.json[1]) ? r.json[1].map((x) => String(x)) : [];
  const cleaned = suggestions.map((s) => s.trim()).filter(Boolean).slice(0, 30);

  memSet(key, cleaned);
  return cleaned;
}

/* -----------------------
 * Placeholder: storyKR, naver (기존 프로젝트용)
 * - interestKR 구현이 목표라 상세는 생략/유지
 * ---------------------- */
async function fromStoryKR({ tf, geo, hl }) {
  // storyKR는 이 답변에서 핵심이 아니라서 "참고용"으로만 유지
  // 필요하면 다음 단계에서 더 고도화 가능
  const base = await fromInterestKR({ tf, geo, hl, limit: 500, reqQuery: { seedMode: 'replace', seeds: getDefaultSeedsKR().join(',') } });
  base.meta.source = 'storyKR';
  base.meta.note = 'storyKR: 현재는 interestKR 축약버전(500개)';
  return base;
}

async function fromNaverDataLabDiscover({ tf, geo, hl, clientId, clientSecret }) {
  // 네이버 DataLab은 "후보 키워드"가 없으면 대량 수집이 불가하므로,
  // interestKR에서 뽑은 후보를 넣고 재랭킹하는 방식으로 확장하는 것이 정석.
  // 여기서는 에러를 던져서 프론트에서 안내하도록 둠.
  throw new Error('naver 소스는 후보 키워드 기반 재랭킹 구조가 필요합니다. interestKR에서 후보를 만든 뒤 재랭킹 버전을 붙이는 방식으로 진행하세요.');
}
