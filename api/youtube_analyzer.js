// /api/youtube_analyzer.js
// Vercel Serverless Function (Node.js runtime)
// YouTube Data API v3 proxy + 채널 입력(URL/@handle/채널ID) 해석
export default async function handler(req,res){
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type,Authorization");
  if(req.method==="OPTIONS") return res.status(200).end();
  res.setHeader("Cache-Control","public, s-maxage=30, stale-while-revalidate=120");

  const apiKey=process.env.YOUTUBE_API_KEY;
  if(!apiKey) return j(res,500,{message:"환경변수 YOUTUBE_API_KEY가 없습니다. Vercel Settings → Environment Variables에 추가하세요."});

  try{
    const action=String(req.query.action||"").trim();
    if(!action) return j(res,400,{message:"action 파라미터가 필요합니다."});
    const regionCode=String(req.query.regionCode||"KR").toUpperCase();
    const hl=String(req.query.hl||(regionCode==="KR"?"ko_KR":"en_US"));

    if(action==="resolve"){
      const input=String(req.query.input||"").trim();
      const allowSearchFallback=String(req.query.allowSearchFallback||"1")==="1";
      if(!input) return j(res,400,{message:"input 파라미터가 비어있습니다."});
      const out=await resolveChannel({input,apiKey,regionCode,hl,allowSearchFallback});
      return j(res,200,out);
    }

    if(action==="videoCategories"){
      const part=String(req.query.part||"snippet");
      const data=await ytGet("/youtube/v3/videoCategories",{part,regionCode,hl},apiKey);
      return j(res,200,{data,meta:{api:"videoCategories.list",quotaUnits:1}});
    }

    if(action==="playlistItems"){
      const playlistId=String(req.query.playlistId||"").trim();
      if(!playlistId) return j(res,400,{message:"playlistId가 필요합니다."});
      const part=String(req.query.part||"contentDetails,snippet");
      const maxResults=clampInt(req.query.maxResults,1,50,50);
      const pageToken=String(req.query.pageToken||"").trim();
      const params={part,playlistId,maxResults};
      if(pageToken) params.pageToken=pageToken;
      const data=await ytGet("/youtube/v3/playlistItems",params,apiKey);
      return j(res,200,{data,meta:{api:"playlistItems.list",quotaUnits:1}});
    }

    if(action==="videos"){
      const id=String(req.query.id||"").trim();
      if(!id) return j(res,400,{message:"id(videoIds)가 필요합니다."});
      const ids=id.split(",").map(s=>s.trim()).filter(Boolean);
      if(ids.length>50) return j(res,400,{message:"id는 최대 50개까지 가능합니다."});
      const part=String(req.query.part||"snippet,contentDetails,statistics");
      const data=await ytGet("/youtube/v3/videos",{part,id:ids.join(",")},apiKey);
      return j(res,200,{data,meta:{api:"videos.list",quotaUnits:1}});
    }

    if(action==="channels"){
      const id=String(req.query.id||"").trim();
      const forHandle=String(req.query.forHandle||"").trim();
      const forUsername=String(req.query.forUsername||"").trim();
      const part=String(req.query.part||"snippet,statistics,contentDetails");
      const params={part};
      if(id) params.id=id;
      else if(forHandle) params.forHandle=forHandle.replace(/^@/,"");
      else if(forUsername) params.forUsername=forUsername;
      else return j(res,400,{message:"channels: id/forHandle/forUsername 중 하나가 필요합니다."});
      const data=await ytGet("/youtube/v3/channels",params,apiKey);
      return j(res,200,{data,meta:{api:"channels.list",quotaUnits:1}});
    }

    if(action==="searchChannels"){
      const q=String(req.query.q||"").trim();
      if(!q) return j(res,400,{message:"q가 필요합니다."});
      const data=await ytGet("/youtube/v3/search",{part:"snippet",q,type:"channel",maxResults:1,regionCode},apiKey);
      return j(res,200,{data,meta:{api:"search.list(type=channel)",quotaUnits:100}});
    }

    return j(res,400,{message:"지원하지 않는 action: "+action});
  }catch(e){
    return j(res,e?.status||500,{message:e?.message||String(e)});
  }
}

async function resolveChannel({input,apiKey,regionCode,hl,allowSearchFallback}){
  const meta={resolvedBy:null,quotaUnits:0};

  const m=input.match(/(UC[0-9A-Za-z_-]{20,})/);
  if(m){
    const ch=await fetchChannelById(m[1],apiKey,hl);
    meta.resolvedBy="channelId"; meta.quotaUnits+=1;
    return {data:{channel:ch},meta};
  }

  let handle=null, username=null;
  if(input.startsWith("@")) handle=input.replace(/^@/,"").split(/[/?#]/)[0];

  if(!handle && /^https?:\/\//i.test(input)){
    try{
      const u=new URL(input);
      const p=u.pathname||"";
      const h=p.match(/\/@([^/]+)/);
      if(h) handle=h[1];
      const c=p.match(/\/channel\/(UC[0-9A-Za-z_-]{20,})/);
      if(c){
        const ch=await fetchChannelById(c[1],apiKey,hl);
        meta.resolvedBy="channelUrl"; meta.quotaUnits+=1;
        return {data:{channel:ch},meta};
      }
      const uu=p.match(/\/user\/(.+)/);
      if(uu) username=uu[1].split("/")[0];
    }catch{}
  }

  if(handle){
    const data=await ytGet("/youtube/v3/channels",{part:"snippet,statistics,contentDetails",forHandle:handle.replace(/^@/,""),hl},apiKey);
    const item=data?.items?.[0];
    if(item?.id){
      meta.resolvedBy="forHandle"; meta.quotaUnits+=1;
      return {data:{channel:normChannel(item)},meta};
    }
    if(allowSearchFallback){
      const ch=await searchChannel(handle,apiKey,regionCode,hl);
      meta.resolvedBy="searchFallback(handle)"; meta.quotaUnits+=100;
      return {data:{channel:ch},meta};
    }
  }

  if(username){
    const data=await ytGet("/youtube/v3/channels",{part:"snippet,statistics,contentDetails",forUsername:username,hl},apiKey);
    const item=data?.items?.[0];
    if(item?.id){
      meta.resolvedBy="forUsername"; meta.quotaUnits+=1;
      return {data:{channel:normChannel(item)},meta};
    }
    if(allowSearchFallback){
      const ch=await searchChannel(username,apiKey,regionCode,hl);
      meta.resolvedBy="searchFallback(username)"; meta.quotaUnits+=100;
      return {data:{channel:ch},meta};
    }
  }

  if(allowSearchFallback){
    const ch=await searchChannel(input,apiKey,regionCode,hl);
    meta.resolvedBy="searchFallback(query)"; meta.quotaUnits+=100;
    return {data:{channel:ch},meta};
  }

  throw httpError(400,"채널 해석 실패: @handle 또는 채널ID로 입력하세요.");
}

async function fetchChannelById(channelId,apiKey,hl){
  const data=await ytGet("/youtube/v3/channels",{part:"snippet,statistics,contentDetails",id:channelId,hl},apiKey);
  const item=data?.items?.[0];
  if(!item?.id) throw httpError(404,"채널을 찾을 수 없습니다.");
  return normChannel(item);
}

async function searchChannel(query,apiKey,regionCode,hl){
  const s=await ytGet("/youtube/v3/search",{part:"snippet",q:query,type:"channel",maxResults:1,regionCode},apiKey);
  const id=s?.items?.[0]?.id?.channelId;
  if(!id) throw httpError(404,"검색으로 채널을 찾을 수 없습니다.");
  return await fetchChannelById(id,apiKey,hl);
}

function normChannel(item){
  const sn=item?.snippet||{};
  const st=item?.statistics||{};
  const cd=item?.contentDetails||{};
  const uploads=cd?.relatedPlaylists?.uploads||null;
  const customUrl=sn.customUrl||null;
  const handle=(customUrl && customUrl.startsWith("@"))?customUrl:null;
  return {
    channelId:item.id,
    title:sn.title||null,
    publishedAt:sn.publishedAt||null,
    customUrl,handle,
    subscriberCount:st.hiddenSubscriberCount?null:num(st.subscriberCount),
    viewCount:num(st.viewCount),
    videoCount:num(st.videoCount),
    uploadsPlaylistId:uploads
  };
}

async function ytGet(path,params,apiKey){
  const url=new URL("https://www.googleapis.com"+path);
  for(const [k,v] of Object.entries(params||{})){
    if(v===undefined||v===null||v==="") continue;
    url.searchParams.set(k,String(v));
  }
  url.searchParams.set("key",apiKey);
  const r=await fetch(url.toString());
  const txt=await r.text();
  let data; try{data=JSON.parse(txt);}catch{data={raw:txt};}
  if(!r.ok){
    const msg=data?.error?.message || ("YouTube API error ("+r.status+")");
    throw httpError(r.status,msg);
  }
  return data;
}

function j(res,status,body){
  res.status(status).setHeader("Content-Type","application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}
function clampInt(v,min,max,fb){const n=parseInt(String(v??""),10);if(!Number.isFinite(n))return fb;return Math.max(min,Math.min(max,n));}
function num(v){const n=Number(v);return Number.isFinite(n)?n:null;}
function httpError(status,message){const e=new Error(message);e.status=status;return e;}
