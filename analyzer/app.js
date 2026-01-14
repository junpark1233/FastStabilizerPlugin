'use strict';
(() => {
(function(){
  "use strict";

  // ---------- Safe runtime error surfacing (no-console needed) ----------
  function showRuntimeError(err){
    try{
      const box = document.getElementById("runtimeError");
      const pre = document.getElementById("runtimeErrorText");
      if(!box || !pre) return;
      box.classList.remove("hidden");
      pre.textContent = String(err && (err.stack || err.message || err) || "Unknown error");
    }catch(_){}
  }
  window.addEventListener("error", (e)=>{ showRuntimeError(e.error || e.message); });
  window.addEventListener("unhandledrejection", (e)=>{ showRuntimeError(e.reason); });

  // ---------- Helpers ----------
  const $ = (id)=>document.getElementById(id);
  const nowIso = ()=>new Date().toISOString();
  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

  function toast(msg, kind){
    const t = $("toast");
    const el = document.createElement("div");
    el.innerHTML = '<div class="text-sm font-semibold">'+(kind==="err"?"오류":"알림")+'</div><div class="muted text-xs mt-1">'+escapeHtml(msg)+'</div>';
    t.appendChild(el);
    setTimeout(()=>{ el.remove(); }, 4200);
  }

  function escapeHtml(s){
    return String(s ?? "").replace(/[&<>"']/g, m=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;" }[m]));
  }

  function formatNumber(n){
    const x = Number(n);
    if(!isFinite(x)) return "";
    return x.toLocaleString("ko-KR");
  }

  function toDate(s){ const d = new Date(s); return isNaN(d.getTime()) ? null : d; }

  function daysSince(iso){
    const d = toDate(iso);
    if(!d) return null;
    const diff = Date.now() - d.getTime();
    return Math.max(1, Math.floor(diff / (1000*60*60*24)));
  }

  function parseDurationISO(iso){
    // ISO8601 duration like PT1H2M3S
    if(!iso || typeof iso !== "string") return { seconds: null, text: "" };
    const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
    if(!m) return { seconds: null, text: iso };
    const h = parseInt(m[1]||"0",10);
    const mm = parseInt(m[2]||"0",10);
    const ss = parseInt(m[3]||"0",10);
    const seconds = h*3600 + mm*60 + ss;
    const text = h>0 ? String(h).padStart(2,"0")+":"+String(mm).padStart(2,"0")+":"+String(ss).padStart(2,"0")
                     : String(mm).padStart(2,"0")+":"+String(ss).padStart(2,"0");
    return { seconds, text };
  }

  // Hashtags extraction (no Unicode property escapes for max compatibility)
  function extractHashtags(title, desc){
    const s = (title||"") + " " + (desc||"");
    const re = /#[A-Za-z0-9_\u3131-\uD79D]+/g; // includes Hangul Jamo + Hangul syllables
    const found = s.match(re) || [];
    const uniq = [];
    const seen = {};
    for(const tag of found){
      const key = tag.toLowerCase();
      if(seen[key]) continue;
      seen[key]=true;
      uniq.push(tag);
    }
    return uniq;
  }

  function tokenizeForKeywords(title, desc){
    const raw = ((title||"") + " " + (desc||""))
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/#[A-Za-z0-9_\u3131-\uD79D]+/g, " ")
      .replace(/[\r\n\t]/g, " ")
      .replace(/[^A-Za-z0-9\u3131-\uD79D ]/g, " ")
      .toLowerCase();

    const tokens = raw.split(/\s+/).filter(Boolean);
    const stop = new Set([
      "the","a","an","and","or","to","of","in","on","for","with","is","are","was","were","be","as","at",
      "this","that","it","you","your","we","our","i","me","my",
      "영상","오늘","진짜","ㅋㅋ","ㅋㅋㅋ","합니다","하기","하는","해서","했다","있는","없음","없다","있다",
      "그리고","하지만","그래서","그런데","때문","정말","완전","너무","이거","저거","그거","우리","나","너",
      "모든","전체","채널","조회수","좋아요","댓글","shorts","쇼츠"
    ]);
    const counts = {};
    for(const t of tokens){
      if(t.length < 2) continue;
      if(stop.has(t)) continue;
      counts[t] = (counts[t]||0)+1;
    }
    const pairs = Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,20);
    return pairs.map(([k,v])=>({ keyword:k, count:v }));
  }

  function safeJson(obj){
    return JSON.stringify(obj, null, 2);
  }

  // ---------- Storage ----------
  const LS = {
    get(k, fallback){ try{ const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; }catch(_){ return fallback; } },
    set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(_){ } },
    del(k){ try{ localStorage.removeItem(k); }catch(_){ } }
  };

  // ---------- State ----------
  const state = {
    theme: "dark",
    apiBase: "",
    mode: "compare",
    quotaUsed: 0,
    quotaTotal: 10000,
    quotaLog: [],
    timerStart: null,
    timerHandle: null,
    channels: {
      A: null,
      B: null
    },
    datasets: {
      A: [],
      B: []
    },
    categoryMaps: {
      A: {},
      B: {}
    },
    filteredRows: [],
    activeTab: "data"
  };

  // ---------- UI: Progress + logs ----------
  function log(msg){
    const box = $("logBox");
    const lines = (LS.get("ya_log", []) || []);
    lines.unshift({ t: Date.now(), msg: String(msg) });
    while(lines.length > 10) lines.pop();
    LS.set("ya_log", lines);
    renderLogs();
  }
  function renderLogs(){
    const box = $("logBox");
    const lines = LS.get("ya_log", []) || [];
    box.innerHTML = lines.map(l=>{
      const t = new Date(l.t).toLocaleTimeString("ko-KR",{hour12:false});
      return '<div><span class="muted">['+t+']</span> '+escapeHtml(l.msg)+'</div>';
    }).join("");
  }

  function setStage(stage, pct){
    $("stage").textContent = stage;
    const p = Math.max(0, Math.min(100, Math.floor(pct||0)));
    $("progressPct").textContent = p + "%";
    $("progressBar").style.width = p + "%";
  }

  function startTimer(){
    state.timerStart = performance.now();
    if(state.timerHandle) clearInterval(state.timerHandle);
    state.timerHandle = setInterval(()=>{
      const sec = (performance.now() - state.timerStart)/1000;
      $("elapsed").textContent = sec.toFixed(1)+"s";
    }, 100);
  }
  function stopTimer(){
    if(state.timerHandle) clearInterval(state.timerHandle);
    state.timerHandle = null;
  }

  // ---------- Quota ----------
  function quotaAdd(units, label){
    const u = Number(units)||0;
    state.quotaUsed = (state.quotaUsed||0) + u;
    $("quotaUsed").textContent = String(state.quotaUsed);
    const logArr = state.quotaLog || [];
    logArr.unshift({ t: Date.now(), u, label: label||"" });
    while(logArr.length > 10) logArr.pop();
    state.quotaLog = logArr;
    LS.set("ya_quotaUsed", state.quotaUsed);
    LS.set("ya_quotaLog", state.quotaLog);
    renderQuotaLog();
  }
  function renderQuotaLog(){
    const box = $("quotaLog");
    const lines = state.quotaLog || [];
    box.innerHTML = lines.map(l=>{
      const t = new Date(l.t).toLocaleTimeString("ko-KR",{hour12:false});
      return '<div><span class="muted">['+t+']</span> +'+l.u+'u '+escapeHtml(l.label)+'</div>';
    }).join("");
  }
  // ---------- API base ----------
  function isFileMode(){
    // Some browsers report file origins as "null", others as "file://"
    return location.protocol === "file:" || location.origin === "null" || String(location.origin||"").toLowerCase().startsWith("file");
  }
  function getApiBase(){
    // Prefer the currently typed value (works even if user didn't press save)
    const typed = ($("apiBase") ? $("apiBase").value : "").trim();
    if(typed) return normalizeBase(typed);
    if(isFileMode()){
      const saved = (state.apiBase || "").trim();
      return saved;
    }
    return location.origin;
  }

    return location.origin;
  }

  function normalizeBase(url){
    let s = String(url||"").trim();
    if(!s) return "";
    // common copy/paste mistakes
    s = s.replace(/^https?:\/\/https?:\/\//i, (m)=> m.toLowerCase().startsWith("https://") ? "https://" : "http://");
    s = s.replace(/^https\/\//i, "https://");
    s = s.replace(/^http\/\//i, "http://");
    // add scheme if missing
    if(!/^https?:\/\//i.test(s)) s = "https://" + s;
    s = s.trim();
    // keep origin only (ignore /analyzer etc)
    try{
      const u = new URL(s);
      return u.origin;
    }catch(e){
      return s.replace(/\/+$/,"");
    }
  }

  // ---------- Fetch ----------
  async function apiBundle(channelKey){
    const isSingle = state.mode === "single";
    if(isSingle && channelKey === "B") return;

    const input = $(channelKey==="A" ? "inputA" : "inputB").value.trim();
    if(!input){
      toast("채널 입력을 해주세요 ("+channelKey+")", "err");
      return;
    }

    const base = getApiBase();
    if(isFileMode() && !base){
      $("fileModeHint").classList.remove("hidden");
      toast("로컬(file://)에서는 API 도메인을 먼저 입력해야 합니다", "err");
      return;
    }

    const max = parseInt($(channelKey==="A" ? "maxA" : "maxB").value, 10);
    const days = parseInt($(channelKey==="A" ? "daysA" : "daysB").value, 10);
    const shorts = parseInt($(channelKey==="A" ? "shortsA" : "shortsB").value, 10);
    const locale = $(channelKey==="A" ? "localeA" : "localeB").value;
    const [region, lang] = locale.split("|");
    const useCache = $(channelKey==="A" ? "cacheA" : "cacheB").checked;
    const allowFallback = $(channelKey==="A" ? "fallbackA" : "fallbackB").checked;
    const lite = $(channelKey==="A" ? "liteA" : "liteB").checked;
    const ttlHours = parseInt($(channelKey==="A" ? "ttlA" : "ttlB").value, 10);

    // Badge
    $(channelKey==="A" ? "badgeA" : "badgeB").textContent = "불러오는 중";

    const cacheKey = "ya_cache_bundle_"+channelKey+"_"+hashKey(input+"|"+max+"|"+days+"|"+region+"|"+lite);
    if(useCache){
      const cached = LS.get(cacheKey, null);
      if(cached && cached.exp && Date.now() < cached.exp && cached.data){
        log(channelKey+": 캐시 사용");
        applyBundle(channelKey, cached.data, shorts);
        $(channelKey==="A" ? "badgeA" : "badgeB").textContent = "캐시";
        refreshTable();
        refreshGpt();
        return;
      }
    }

    startTimer();
    setStage(channelKey+": 채널조회", 5);
    log(channelKey+": API 호출 시작");

    const url = normalizeBase(base) + "/api/youtube_analyzer"
      + "?action=bundle"
      + "&input=" + encodeURIComponent(input)
      + "&max=" + encodeURIComponent(String(max))
      + "&days=" + encodeURIComponent(String(days))
      + "&region=" + encodeURIComponent(region)
      + "&lang=" + encodeURIComponent(lang)
      + "&allowSearchFallback=" + encodeURIComponent(allowFallback ? "1" : "0")
      + "&lite=" + encodeURIComponent(lite ? "1" : "0");

    try{
      const resp = await fetch(url, { method:"GET" });
      const data = await resp.json().catch(()=>({}));
      if(!resp.ok){
        const msg = (data && data.error && data.error.message) ? data.error.message : ("HTTP "+resp.status);
        throw new Error(msg);
      }
      const units = data && data.quota && data.quota.estimatedUnitsThisCall ? data.quota.estimatedUnitsThisCall : 0;
      quotaAdd(units, channelKey+" bundle");
      if(useCache){
        LS.set(cacheKey, { exp: Date.now() + ttlHours*3600*1000, data });
      }
      applyBundle(channelKey, data, shorts);
      $(channelKey==="A" ? "badgeA" : "badgeB").textContent = "완료";
      log(channelKey+": 완료 ("+state.datasets[channelKey].length+"개)");
      setStage("화면 렌더", 100);
      stopTimer();
      refreshTable();
      refreshGpt();
      toast(channelKey+" 채널 불러오기 완료");
    }catch(err){
      stopTimer();
      $(channelKey==="A" ? "badgeA" : "badgeB").textContent = "오류";
      setStage("오류", 0);
      log(channelKey+": 오류 - "+String(err && err.message || err) + " | URL: " + url);
      (String(err && err.message || err) === "Failed to fetch"
        ? toast("Failed to fetch — 상단 ‘연결 테스트’로 /api/youtube_analyzer 배포/도메인 상태부터 확인해 주세요", "err")
        : toast(String(err && err.message || err), "err"));
    }
  }

  function applyBundle(channelKey, bundle, shortsThreshold){
    // channel
    state.channels[channelKey] = bundle.channel || null;
    state.categoryMaps[channelKey] = bundle.categoryMap || {};
    const vids = (bundle.videos || []).map(v=>{
      const d = parseDurationISO(v.duration || v.contentDetails_duration || "");
      const days = daysSince(v.publishedAt);
      const views = Number(v.viewCount || 0);
      const vpd = days ? views / days : 0;
      const tags = extractHashtags(v.title, v.description);
      const isShort = (d.seconds != null) ? (d.seconds <= shortsThreshold) : null;
      const kind = isShort===null ? "" : (isShort ? "쇼츠" : "롱폼");
      return {
        channelKey,
        channelId: bundle.channel ? bundle.channel.channelId : "",
        channelTitle: bundle.channel ? bundle.channel.title : "",
        videoId: v.videoId,
        url: v.url || ("https://www.youtube.com/watch?v="+v.videoId),
        title: v.title || "",
        publishedAt: v.publishedAt,
        description: v.description || "",
        categoryId: v.categoryId || "",
        categoryName: (bundle.categoryMap && v.categoryId && bundle.categoryMap[v.categoryId]) ? bundle.categoryMap[v.categoryId] : "",
        durationISO: v.duration || "",
        durationSeconds: d.seconds,
        durationText: d.text,
        type: kind,
        viewCount: views,
        viewsPerDay: Math.round(vpd*10)/10,
        likeCount: (v.likeCount===null || v.likeCount===undefined) ? null : Number(v.likeCount),
        commentCount: (v.commentCount===null || v.commentCount===undefined) ? null : Number(v.commentCount),
        hashtags: tags
      };
    });
    state.datasets[channelKey] = vids;

    // summaries
    renderSummaries();
  }

  function renderSummaries(){
    $("summaryA").innerHTML = renderChannelSummary(state.channels.A, "A");
    $("summaryB").innerHTML = renderChannelSummary(state.channels.B, "B");
  }

  function renderChannelSummary(ch, key){
    const isSingle = state.mode==="single";
    if(isSingle && key==="B") return '<span class="muted">단일 모드</span>';
    if(!ch) return '<span class="muted">미로드</span>';
    const subs = (ch.subscriberCount===null || ch.subscriberCount===undefined) ? "" : formatNumber(ch.subscriberCount);
    const views = formatNumber(ch.viewCount);
    const vcnt = formatNumber(ch.videoCount);
    const handle = ch.handle || ch.customUrl || "";
    const pub = ch.publishedAt ? ch.publishedAt.slice(0,10) : "";
    const link = ch.url || "";
    return `
      <div class="flex flex-col gap-1">
        <div class="font-semibold">${escapeHtml(ch.title||"")}</div>
        <div class="muted text-xs">${escapeHtml(handle)} · 개설 ${escapeHtml(pub)}</div>
        <div class="flex flex-wrap gap-2 mt-1">
          <span class="pill">구독자 ${subs ? subs : "비공개/불가"}</span>
          <span class="pill">조회수 ${views}</span>
          <span class="pill">영상 ${vcnt}</span>
        </div>
        <div class="muted text-xs mt-1"><a class="link" href="${escapeHtml(link)}" target="_blank" rel="noreferrer">채널 열기</a></div>
      </div>
    `;
  }

  function hashKey(s){
    // simple hash (FNV-1a)
    let h = 2166136261;
    for(let i=0;i<s.length;i++){
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h>>>0).toString(16);
  }

  // ---------- Filtering / table ----------
  function getTargetRows(){
    const t = $("tableTarget").value;
    if(t==="A") return state.datasets.A || [];
    if(t==="B") return state.datasets.B || [];
    return ([]).concat(state.datasets.A||[], state.datasets.B||[]);
  }

  function currentShortsThresholdForRow(row){
    // Per-channel threshold based on selectors
    if(row.channelKey==="A") return parseInt($("shortsA").value, 10);
    return parseInt($("shortsB").value, 10);
  }

  function applyFilters(){
    const rows = getTargetRows().slice();
    const type = $("filterType").value;
    const minV = parseInt(($("viewsMin").value||"").replace(/,/g,""),10);
    const maxV = parseInt(($("viewsMax").value||"").replace(/,/g,""),10);
    const daysFilter = $("filterDays").value;
    const q = ($("searchText").value||"").trim().toLowerCase();
    const sortBy = $("sortBy").value;

    const filtered = rows.filter(r=>{
      // type
      if(type==="shorts" && r.type!=="쇼츠") return false;
      if(type==="long" && r.type!=="롱폼") return false;

      // views range
      const v = Number(r.viewCount||0);
      if(isFinite(minV) && !isNaN(minV) && v < minV) return false;
      if(isFinite(maxV) && !isNaN(maxV) && v > maxV) return false;

      // uploaded within
      if(daysFilter!=="all"){
        const d = toDate(r.publishedAt);
        if(!d) return false;
        const cutoff = Date.now() - parseInt(daysFilter,10)*86400000;
        if(d.getTime() < cutoff) return false;
      }

      // search
      if(q){
        const inTitle = (r.title||"").toLowerCase().includes(q);
        const inTags = (r.hashtags||[]).some(x=>x.toLowerCase().includes(q));
        if(!inTitle && !inTags) return false;
      }
      return true;
    });

    // sort
    filtered.sort((a,b)=>{
      if(sortBy==="views_desc") return (b.viewCount||0) - (a.viewCount||0);
      if(sortBy==="vpd_desc") return (b.viewsPerDay||0) - (a.viewsPerDay||0);
      if(sortBy==="vpd_asc") return (a.viewsPerDay||0) - (b.viewsPerDay||0);
      // date desc
      return String(b.publishedAt||"").localeCompare(String(a.publishedAt||""));
    });

    state.filteredRows = filtered;
    $("countTotal").textContent = String(rows.length);
    $("countFiltered").textContent = String(filtered.length);
    renderTable();
  }

  function renderTable(){
    const body = $("tableBody");
    const rows = state.filteredRows || [];
    if(!rows.length){
      body.innerHTML = '<tr><td class="py-3 px-2 muted" colspan="11">데이터가 없습니다. 먼저 채널을 불러오고 필터를 적용하세요.</td></tr>';
      return;
    }
    body.innerHTML = rows.map((r, idx)=>{
      const tags = (r.hashtags||[]);
      const short = tags.slice(0,3).join(" ");
      const more = tags.length > 3;
      const like = (r.likeCount===null) ? "" : formatNumber(r.likeCount);
      const comm = (r.commentCount===null) ? "" : formatNumber(r.commentCount);
      const ch = (r.channelKey==="A") ? "A" : "B";
      return `
        <tr class="border-t border-white/5 hover:bg-white/5 cursor-pointer" data-idx="${idx}">
          <td class="py-2 px-2 muted text-xs">${idx+1}</td>
          <td class="py-2 px-2">
            <div class="font-semibold">${escapeHtml(r.title)}</div>
            <div class="muted text-xs mt-1">${ch} · <a class="link" href="${escapeHtml(r.url)}" target="_blank" rel="noreferrer">영상</a></div>
          </td>
          <td class="py-2 px-2 muted text-xs">${escapeHtml((r.publishedAt||"").slice(0,10))}</td>
          <td class="py-2 px-2 muted text-xs">${escapeHtml(r.durationText||"")}</td>
          <td class="py-2 px-2"><span class="pill">${escapeHtml(r.type||"")}</span></td>
          <td class="py-2 px-2 text-right">${formatNumber(r.viewCount||0)}</td>
          <td class="py-2 px-2 text-right">${formatNumber(r.viewsPerDay||0)}</td>
          <td class="py-2 px-2 text-right">${like}</td>
          <td class="py-2 px-2 text-right">${comm}</td>
          <td class="py-2 px-2 muted text-xs">${escapeHtml(r.categoryName||"")}</td>
          <td class="py-2 px-2 muted text-xs">
            ${escapeHtml(short)}${more ? ' <button class="btn px-2 py-1 rounded-lg text-xs ml-1 btnMore" data-idx="'+idx+'">더보기</button>' : ''}
          </td>
        </tr>
      `;
    }).join("");

    // row click
    body.querySelectorAll("tr[data-idx]").forEach(tr=>{
      tr.addEventListener("click", (e)=>{
        // if clicked "더보기", ignore (handled separately)
        if(e.target && e.target.classList && e.target.classList.contains("btnMore")) return;
        const i = parseInt(tr.getAttribute("data-idx"),10);
        openModal(rows[i]);
      });
    });
    body.querySelectorAll(".btnMore").forEach(btn=>{
      btn.addEventListener("click", (e)=>{
        e.stopPropagation();
        const i = parseInt(btn.getAttribute("data-idx"),10);
        const r = rows[i];
        toast((r.hashtags||[]).join(" "), "ok");
      });
    });
  }

  function refreshTable(){
    // default table target based on mode
    if(state.mode==="single"){
      $("tableTarget").value = "A";
      $("tableTarget").disabled = true;
    }else{
      $("tableTarget").disabled = false;
    }
    applyFilters();
  }

  // ---------- Modal ----------
  function openModal(r){
    if(!r) return;
    $("modalBackdrop").style.display = "block";
    $("modal").style.display = "block";
    const tags = (r.hashtags||[]).join(" ");
    const like = (r.likeCount===null) ? "비공개/불가" : formatNumber(r.likeCount);
    const comm = (r.commentCount===null) ? "비공개/불가" : formatNumber(r.commentCount);
    $("modalBody").innerHTML = `
      <div class="flex flex-col gap-2">
        <div class="text-base font-bold">${escapeHtml(r.title)}</div>
        <div class="muted text-xs">${escapeHtml(r.publishedAt)} · ${escapeHtml(r.type)} · ${escapeHtml(r.durationText||"")}</div>
        <div class="flex flex-wrap gap-2 mt-1">
          <span class="pill">조회수 ${formatNumber(r.viewCount||0)}</span>
          <span class="pill">조회수/일 ${formatNumber(r.viewsPerDay||0)}</span>
          <span class="pill">좋아요 ${like}</span>
          <span class="pill">댓글 ${comm}</span>
          <span class="pill">카테고리 ${escapeHtml(r.categoryName||"")}</span>
        </div>
        <div class="mt-2">
          <div class="muted text-xs mb-1">해시태그</div>
          <div class="text-sm">${escapeHtml(tags || "없음")}</div>
        </div>
        <div class="mt-2">
          <div class="muted text-xs mb-1">설명(일부)</div>
          <div class="panel2 rounded-xl p-3 text-xs mono whitespace-pre-wrap max-h-[240px] overflow-auto scrollbar">${escapeHtml((r.description||"").slice(0,2500))}</div>
        </div>
        <div class="mt-2">
          <a class="link text-sm" href="${escapeHtml(r.url)}" target="_blank" rel="noreferrer">YouTube에서 열기</a>
        </div>
      </div>
    `;
  }
  function closeModal(){
    $("modalBackdrop").style.display = "none";
    $("modal").style.display = "none";
  }

  // ---------- GPT pack / prompt ----------
  function buildPack(mode){
    // mode: my, bench, compare
    const filters = {
      tableTarget: $("tableTarget").value,
      filterType: $("filterType").value,
      viewsMin: $("viewsMin").value || "",
      viewsMax: $("viewsMax").value || "",
      filterDays: $("filterDays").value,
      searchText: $("searchText").value || "",
      sortBy: $("sortBy").value,
      shortsThresholdA: parseInt($("shortsA").value,10),
      shortsThresholdB: parseInt($("shortsB").value,10),
      collected: {
        A: { max: parseInt($("maxA").value,10), days: parseInt($("daysA").value,10) },
        B: { max: parseInt($("maxB").value,10), days: parseInt($("daysB").value,10) }
      }
    };

    const rows = (state.filteredRows||[]);
    const keywordSummary = (() => {
      const tgt = rows.slice(0,200); // cap for speed
      const joinedTitle = tgt.map(r=>r.title||"").join(" ");
      const joinedDesc = tgt.map(r=>(r.description||"").slice(0,300)).join(" ");
      return tokenizeForKeywords(joinedTitle, joinedDesc);
    })();

    function topBy(list, keyFn, n){
      const copy = list.slice();
      copy.sort((a,b)=>keyFn(b)-keyFn(a));
      return copy.slice(0,n);
    }
    function bottomBy(list, keyFn, n){
      const copy = list.slice();
      copy.sort((a,b)=>keyFn(a)-keyFn(b));
      return copy.slice(0,n);
    }

    const topByViews = topBy(rows, r=>Number(r.viewCount||0), 10);
    const topByVPD = topBy(rows, r=>Number(r.viewsPerDay||0), 10);
    const bottomByVPD = bottomBy(rows, r=>Number(r.viewsPerDay||0), 10);

    // pack schema
    const pack = {
      meta: {
        generatedAt: nowIso(),
        mode: mode,
        filters
      },
      channel: null,
      channels: undefined, // used only for compare
      videos: rows.map(r=>({
        channelKey: r.channelKey,
        channelTitle: r.channelTitle,
        videoId: r.videoId,
        title: r.title,
        publishedAt: r.publishedAt,
        duration: r.durationISO,
        durationSeconds: r.durationSeconds,
        viewCount: r.viewCount,
        viewsPerDay: r.viewsPerDay,
        likeCount: r.likeCount,
        commentCount: r.commentCount,
        categoryId: r.categoryId,
        categoryName: r.categoryName,
        hashtags: r.hashtags || [],
        url: r.url
      })),
      topVideos: {
        byViews: topByViews.map(minVideo),
        byViewsPerDay: topByVPD.map(minVideo)
      },
      bottomVideos: bottomByVPD.map(minVideo),
      keywordSummary,
      notes: "공개 데이터 한계: CTR/유지율/시청지속시간/노출수 등 비공개 지표는 불가. like/comment는 채널 설정에 따라 비공개면 빈값."
    };

    function minVideo(r){
      return {
        channelKey: r.channelKey,
        videoId: r.videoId,
        title: r.title,
        publishedAt: r.publishedAt,
        viewCount: r.viewCount,
        viewsPerDay: r.viewsPerDay,
        url: r.url
      };
    }

    if(mode==="my"){
      pack.channel = state.channels.A || null;
      delete pack.channels;
    }else if(mode==="bench"){
      pack.channel = state.channels.B || null;
      delete pack.channels;
    }else{
      // compare
      pack.channels = { A: state.channels.A || null, B: state.channels.B || null };
      pack.channel = null;
    }
    return pack;
  }

  function buildPrompt(mode){
    const baseRules = [
      "너는 “유튜브 데이터 리서처 + 쇼츠 성장 분석가”다.",
      "아래 ‘분석팩(JSON)’만 근거로, 공개 데이터로 가능한 범위에서만 분석해라.",
      "CTR/유지율/시청지속시간/노출수 등 비공개 지표는 ‘불가’로 명확히 표기하고 추정하지 마라.",
      "앱이 만든 결론을 믿지 말고, 데이터에서 근거를 찾아라.",
      "출력은 Markdown으로."
    ];

    const tasksMy = [
      "1) 채널 현황 요약(공개 지표 기반)",
      "2) 업로드/조회수/조회수-일 분포 관찰(근거 숫자 포함)",
      "3) 제목/해시태그 패턴 10개(근거 예시 링크 포함)",
      "4) 2주 실행안 10개(실행 순서 포함)",
      "5) 제목 템플릿 20개 + 훅 20개(너무 비슷한 문장 반복 금지)"
    ];
    const tasksBench = [
      "1) 벤치 채널의 ‘잘 먹히는 제목/해시태그’ 규칙 10개(근거 예시 링크 포함)",
      "2) 조회수-일 상위 Top 10 영상 공통점 10개(데이터 근거)",
      "3) 내 채널에 이식 가능한 포맷 10개(피해야 할 포인트 포함)",
      "4) 2주 실행안 10개(벤치 규칙을 반영)"
    ];
    const tasksCompare = [
      "1) A vs B: 업로드 주기/조회수/조회수-일 비교(표로)",
      "2) B 승리 규칙 10개(데이터 근거 포함)",
      "3) A의 즉시 개선 포인트 10개(데이터 근거 포함)",
      "4) 2주 실행안 10개(실행 순서 + 측정 방법 포함)"
    ];

    const tasks = mode==="my" ? tasksMy : (mode==="bench" ? tasksBench : tasksCompare);

    const header = baseRules.join("\n");
    const body = tasks.join("\n");
    const tail = [
      "",
      "=== 분석팩(JSON) ===",
      "(아래에 내가 붙여넣는 JSON을 그대로 읽고 분석해라)"
    ].join("\n");

    return header + "\n\n" + body + "\n" + tail;
  }

  function refreshGpt(){
    const mode = document.querySelector('input[name="gptMode"]:checked')?.value || "my";
    $("gptPrompt").value = buildPrompt(mode);
    $("gptPack").value = safeJson(buildPack(mode));
  }

  // ---------- Export ----------
  function rowsToExport(){
    const rows = state.filteredRows || [];
    return rows.map(r=>({
      channelKey: r.channelKey,
      channelTitle: r.channelTitle,
      videoId: r.videoId,
      title: r.title,
      publishedAt: r.publishedAt,
      duration: r.durationText,
      type: r.type,
      viewCount: r.viewCount,
      viewsPerDay: r.viewsPerDay,
      likeCount: r.likeCount,
      commentCount: r.commentCount,
      categoryName: r.categoryName,
      hashtags: (r.hashtags||[]).join(" "),
      url: r.url
    }));
  }

  function exportCsv(){
    const name = ($("exportName").value||"export").trim() || "export";
    const rows = rowsToExport();
    if(!rows.length){ toast("내보낼 데이터가 없습니다", "err"); return; }
    const headers = Object.keys(rows[0]);
    const lines = [headers.join(",")];
    for(const row of rows){
      const vals = headers.map(h=>{
        const v = row[h];
        const s = (v===null||v===undefined) ? "" : String(v).replace(/"/g,'""');
        return '"' + s + '"';
      });
      lines.push(vals.join(","));
    }
    const blob = new Blob([lines.join("\n")], { type:"text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name + ".csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast("CSV 내보내기 완료");
  }

  function exportXlsx(){
    const name = ($("exportName").value||"export").trim() || "export";
    const rows = rowsToExport();
    if(!rows.length){ toast("내보낼 데이터가 없습니다", "err"); return; }
    if(!window.XLSX){
      toast("SheetJS 로딩 실패(인터넷 확인)", "err");
      return;
    }
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "videos");
    XLSX.writeFile(wb, name + ".xlsx");
    toast("XLSX 내보내기 완료");
  }

  // ---------- Copy ----------
  async function copyText(txt){
    try{
      await navigator.clipboard.writeText(txt);
      toast("복사 완료");
    }catch(_){
      // fallback
      const ta = document.createElement("textarea");
      ta.value = txt;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      toast("복사 완료");
    }
  }

  // ---------- Tabs ----------
  function setTab(name){
    state.activeTab = name;
    ["data","gpt","export"].forEach(t=>{
      const el = $("tab-"+t);
      if(t===name) el.classList.remove("hidden");
      else el.classList.add("hidden");
    });
    document.querySelectorAll(".tab").forEach(btn=>{
      const on = btn.getAttribute("data-tab")===name;
      btn.classList.toggle("tab-active", on);
      btn.classList.toggle("font-semibold", on);
    });
    if(name==="gpt") refreshGpt();
  }

  // ---------- Theme ----------
  function applyTheme(){
    document.documentElement.setAttribute("data-theme", state.theme==="light" ? "light" : "dark");
    $("btnTheme").textContent = state.theme==="light" ? "다크" : "라이트";
  }

  // ---------- Init ----------
  function init(){
    // default: dark
    state.theme = LS.get("ya_theme", "dark");
    state.apiBase = LS.get("ya_apiBase", "");
    state.quotaUsed = LS.get("ya_quotaUsed", 0);
    state.quotaLog = LS.get("ya_quotaLog", []);
    state.quotaTotal = LS.get("ya_quotaTotal", 10000);

    $("apiBase").value = state.apiBase || "";
    $("quotaUsed").textContent = String(state.quotaUsed);
    $("quotaTotal").value = String(state.quotaTotal);
    renderQuotaLog();
    renderLogs();

    // file mode hint
    if(isFileMode()){
      $("fileModeHint").classList.remove("hidden");
    }

    // default disable B in single mode
    setModeFromRadios();

    applyTheme();
    refreshTable();
    refreshGpt();
  }

  function setModeFromRadios(){
    const m = document.querySelector('input[name="mode"]:checked')?.value || "compare";
    state.mode = m;
    if(m==="single"){
      // disable B controls
      ["inputB","btnLoadB","maxB","daysB","shortsB","localeB","cacheB","fallbackB","liteB","ttlB"].forEach(id=>{
        const el = $(id); if(el) el.disabled = true;
      });
      $("badgeB").textContent = "단일";
      $("summaryB").textContent = "단일 모드";
      $("tableTarget").value = "A";
      $("tableTarget").disabled = true;
    }else{
      ["inputB","btnLoadB","maxB","daysB","shortsB","localeB","cacheB","fallbackB","liteB","ttlB"].forEach(id=>{
        const el = $(id); if(el) el.disabled = false;
      });
      $("tableTarget").disabled = false;
      if($("badgeB").textContent==="단일") $("badgeB").textContent="대기";
      renderSummaries();
    }
  }

  // ---------- Wire events (DOMContentLoaded safe) ----------
  document.addEventListener("DOMContentLoaded", ()=>{
    try{
      init();

      $("btnRoot").addEventListener("click", ()=>{
        const base = getApiBase() || location.origin;
        if(base && base!=="null") window.location.href = normalizeBase(base) + "/";
        else window.location.href = "/";
      });

      $("btnResetAll").addEventListener("click", ()=>{
        if(!confirm("로컬 저장(캐시/설정/쿼터)을 모두 초기화할까요?")) return;
        Object.keys(localStorage).filter(k=>k.startsWith("ya_")).forEach(k=>localStorage.removeItem(k));
        location.reload();
      });

      $("btnTheme").addEventListener("click", ()=>{
        state.theme = (state.theme==="light") ? "dark" : "light";
        LS.set("ya_theme", state.theme);
        applyTheme();
      });

      $("btnSaveApiBase").addEventListener("click", ()=>{
        state.apiBase = normalizeBase($("apiBase").value);
        $("apiBase").value = state.apiBase;
        LS.set("ya_apiBase", state.apiBase);
        toast("API 도메인 저장 완료");
      });

      async function testApiConnection(){
        try{
          const base = normalizeBase($("apiBase").value || state.apiBase || "");
          if(!base){
            $("apiTestStatus").classList.remove("hidden");
            $("apiTestStatus").textContent = "API 도메인을 입력해 주세요 (예: https://fast-stabilizer-plugin.vercel.app)";
            toast("API 도메인 입력 필요", "err");
            return;
          }
          // persist normalized base immediately
          state.apiBase = base;
          $("apiBase").value = base;
          LS.set("ya_apiBase", state.apiBase);

          const pingUrl = base + "/api/youtube_analyzer?action=ping";
          $("apiTestStatus").classList.remove("hidden");
          $("apiTestStatus").textContent = "연결 테스트 중... " + pingUrl;
          log("API ping: " + pingUrl);

          const resp = await fetch(pingUrl, { method:"GET" });
          const txt = await resp.text();
          let data = null;
          try{ data = JSON.parse(txt); }catch(e){}

          if(!resp.ok){
            $("apiTestStatus").textContent = "연결 실패 (HTTP " + resp.status + "). /api/youtube_analyzer 가 배포되어 있는지 확인해 주세요.";
            toast("연결 실패 (HTTP "+resp.status+")", "err");
            return;
          }
          if(!data || !data.ok){
            $("apiTestStatus").textContent = "연결은 되었지만 응답이 예상과 다릅니다. /api/youtube_analyzer 가 리라이트에 잡혔을 수 있어요.";
            toast("연결 응답 이상", "err");
            return;
          }
          $("apiTestStatus").textContent = "연결 OK ✅ (" + (data.version||"") + ") — " + pingUrl;
          toast("API 연결 OK");
        }catch(err){
          $("apiTestStatus").classList.remove("hidden");
          $("apiTestStatus").textContent = "연결 실패: " + String(err && err.message || err) + " (도메인/배포/CORS 확인 필요)";
          toast("연결 실패", "err");
        }
      }

      $("btnTestApiBase").addEventListener("click", testApiConnection);


      document.querySelectorAll('input[name="mode"]').forEach(r=>{
        r.addEventListener("change", ()=>{
          setModeFromRadios();
          refreshTable();
          refreshGpt();
        });
      });

      $("btnLoadA").addEventListener("click", ()=>apiBundle("A"));
      $("btnLoadB").addEventListener("click", ()=>apiBundle("B"));

      $("btnQuotaReset").addEventListener("click", ()=>{
        state.quotaUsed = 0;
        state.quotaLog = [];
        LS.set("ya_quotaUsed", 0);
        LS.set("ya_quotaLog", []);
        $("quotaUsed").textContent = "0";
        renderQuotaLog();
        toast("오늘치 초기화 완료");
      });

      $("quotaTotal").addEventListener("change", ()=>{
        const v = parseInt($("quotaTotal").value,10);
        state.quotaTotal = isFinite(v) && v>0 ? v : 10000;
        $("quotaTotal").value = String(state.quotaTotal);
        LS.set("ya_quotaTotal", state.quotaTotal);
      });

      document.querySelectorAll(".tab").forEach(btn=>{
        btn.addEventListener("click", ()=> setTab(btn.getAttribute("data-tab")));
      });

      $("btnApplyFilters").addEventListener("click", ()=> { applyFilters(); refreshGpt(); });
      $("btnResetFilters").addEventListener("click", ()=>{
        $("filterType").value="all";
        $("viewsMin").value="";
        $("viewsMax").value="";
        $("filterDays").value="all";
        $("searchText").value="";
        $("sortBy").value="date_desc";
        applyFilters(); refreshGpt();
      });

      document.querySelectorAll(".quickViews").forEach(btn=>{
        btn.addEventListener("click", ()=>{
          $("viewsMin").value = btn.getAttribute("data-quick");
          $("viewsMax").value = "";
          applyFilters(); refreshGpt();
        });
      });
      $("btnQuickClear").addEventListener("click", ()=>{
        $("viewsMin").value = "";
        $("viewsMax").value = "";
        applyFilters(); refreshGpt();
      });

      $("tableTarget").addEventListener("change", ()=>{ applyFilters(); refreshGpt(); });

      $("btnCopyTableJson").addEventListener("click", ()=>{
        const rows = state.filteredRows || [];
        copyText(safeJson(rows));
      });

      // GPT buttons
      document.querySelectorAll('input[name="gptMode"]').forEach(r=>{
        r.addEventListener("change", refreshGpt);
      });
      $("btnRefreshGpt").addEventListener("click", refreshGpt);
      $("btnCopyPack").addEventListener("click", ()=> copyText($("gptPack").value || ""));
      $("btnCopyPrompt").addEventListener("click", ()=> copyText($("gptPrompt").value || ""));
      $("btnCopyBoth").addEventListener("click", ()=>{
        const txt = ($("gptPrompt").value||"") + "\n\n" + ($("gptPack").value||"");
        copyText(txt);
      });

      // export
      $("btnExportCsv").addEventListener("click", exportCsv);
      $("btnExportXlsx").addEventListener("click", exportXlsx);

      // modal
      $("btnCloseModal").addEventListener("click", closeModal);
      $("modalBackdrop").addEventListener("click", closeModal);

      // initial table render
      applyFilters();

      toast("준비 완료");
    }catch(err){
      showRuntimeError(err);
    }
  });

})();
})();
