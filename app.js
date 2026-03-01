"use strict";

/**
 * 目的（ブレなし）
 * - 一定速度（区間倍率なし）
 * - 音源終了の6秒前(T-6)に「スライドが完全に流れ終わって停止」
 * - 残り6秒は余韻（スライド停止、背景/粒子は薄く動く）
 * - currentTimeが微妙に戻っても映像が戻らない（単調増加タイム）
 * - 30fps描画
 *
 * 演出（ステッカー無し）
 * - 背景グラデゆっくり変化
 * - スポットライトスイープ
 * - 粒子（軽量）
 * - 画像の微ケンバーンズ（ごく弱いズーム＋微回転）
 * - 右下球体：呼吸＋微回転＋たまに瞬間静止（シュール）
 */

const $ = (id) => document.getElementById(id);
const must = (id) => { const el = $(id); if (!el) throw new Error(`#${id} not found`); return el; };
const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));

const imgInput = must("imgInput");
const audInput = must("audInput");
const imgList = must("imgList");

const audioEl = must("audio");
const audLenEl = must("audLen");
const fitModeEl = must("fitMode");
const orbOnEl = must("orbOn");

const btnPreview = must("btnPreview");
const btnGenerate = must("btnGenerate");
const btnAbort = must("btnAbort");
const btnFS = must("btnFS");

const dlLink = must("dlLink");
const statusPill = must("statusPill");
const badge = must("badge");
const bar = must("bar");
const stateBadge = must("stateBadge");
const logEl = must("log");

const stage = must("stage");
const cv = must("cv");
const ctx = cv.getContext("2d", { alpha:false });

const END_LEAD_SEC = 6.0;
const FPS = 30;

let items = []; // {id,name,url,img,seed}
let audioFile = null;
let T = 0;

let playing = false;
let generating = false;
let raf = 0;
let lastTs = 0;
let accum = 0;

let tMono = 0;          // 戻らない時間
let baseDistance = 0;   // 「流れ終わり」までの総距離(px)
let pps = 0;            // 一定速度(px/s)

let recorder = null;
let recChunks = [];

// ========= utilities =========
function logLine(msg){
  const t = new Date().toLocaleTimeString();
  logEl.textContent = `[${t}] ${msg}\n` + logEl.textContent;
}
function setStatus(s){ statusPill.textContent = s; }
function setState(s){ stateBadge.textContent = s; }
function clearDownloads(){ dlLink.style.display="none"; dlLink.href="#"; }

function fmtTime(s){
  if (!Number.isFinite(s)) return "-";
  const m = Math.floor(s/60);
  const ss = String(Math.floor(s%60)).padStart(2,"0");
  return `${m}:${ss}`;
}
function makeId(){
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return "id_" + Math.random().toString(16).slice(2) + "_" + Date.now().toString(16);
}
function hash01(n){
  const x = Math.sin(n * 999.123 + 0.12345) * 43758.5453;
  return x - Math.floor(x);
}
function easeInOut(t){
  return t<0.5 ? 2*t*t : 1 - Math.pow(-2*t+2,2)/2;
}

// ========= fixed 1920x1080 =========
let resizePending=false;
function resizeCanvas(){
  const r = stage.getBoundingClientRect();
  const cssW = Math.max(1, Math.floor(r.width));
  const cssH = Math.max(1, Math.floor(r.height));
  const W=1920, H=1080;
  if (cv.width!==W) cv.width=W;
  if (cv.height!==H) cv.height=H;
  ctx.setTransform(W/cssW,0,0,H/cssH,0,0);
}
function requestResize(){
  if (resizePending) return;
  resizePending=true;
  requestAnimationFrame(()=>{ resizePending=false; resizeCanvas(); rebuildTiming(); });
}
new ResizeObserver(requestResize).observe(stage);
window.addEventListener("resize", requestResize);
document.addEventListener("fullscreenchange", requestResize);
requestResize();

// ========= particles =========
let particles = [];
function initParticles(){
  const N = 90;
  particles = [];
  for (let i=0; i<N; i++){
    particles.push({
      x: hash01(i*3+1),
      y: hash01(i*7+2),
      r: 0.6 + 1.8*hash01(i*11+3),
      sp: 0.015 + 0.04*hash01(i*13+4),
      drift: (hash01(i*17+5)-0.5) * 0.06,
      a: 0.08 + 0.18*hash01(i*19+6)
    });
  }
}

function bgTheme(t){
  const seg = 14.0;
  const k = Math.floor(t/seg);
  const u = (t - k*seg)/seg;
  const a = hash01(k*3+1);
  const b = hash01((k+1)*3+1);

  const hue = (a*360*(1-u) + b*360*u) % 360;
  const hue2 = (hue + 65 + 40*Math.sin(t*0.08)) % 360;
  return { hue, hue2, u };
}

// ========= orb =========
let orbPhase = 0;
let orbFreeze = 0;

// ========= timing =========
function calcBaseDistance(){
  if (items.length===0) return 0;

  const r = stage.getBoundingClientRect();
  const H = r.height;
  const W = r.width;
  const imgH = H * 0.78;

  const gap = 34;
  const tailPad = Math.max(160, W * 0.55);

  let w = 0;
  for (const it of items){
    const iw = it.img?.width || 1000;
    const ih = it.img?.height || 1000;
    let drawW = imgH*(iw/ih);
    if (fitModeEl.value==="cover") drawW *= 1.08;
    w += drawW + gap;
  }
  w += tailPad;
  return w;
}

function rebuildTiming(){
  baseDistance = calcBaseDistance();
  if (!Number.isFinite(T) || T<=0 || baseDistance<=0){
    pps = 0;
    return;
  }
  const Tg = Math.max(0.5, T - END_LEAD_SEC);
  pps = baseDistance / Tg;
  logLine(`✅ timing: T=${T.toFixed(2)} Tg=${Tg.toFixed(2)} dist=${baseDistance.toFixed(1)} pps=${pps.toFixed(3)}`);
}

fitModeEl.addEventListener("change", ()=>{ rebuildTiming(); });

// ========= list UI =========
function renderList(){
  imgList.innerHTML="";
  if (items.length===0){
    const d=document.createElement("div");
    d.className="hint";
    d.textContent="画像がまだない。";
    imgList.appendChild(d);
    return;
  }
  items.forEach((it,idx)=>{
    const row=document.createElement("div");
    row.className="item";
    row.draggable=true;
    row.dataset.index=String(idx);
    row.innerHTML=`
      <div class="thumb"><img src="${it.url}" alt=""></div>
      <div>
        <div class="name" title="${it.name}">${it.name}</div>
        <div class="ctrls">
          <button class="mini" data-act="up">↑</button>
          <button class="mini" data-act="down">↓</button>
          <button class="mini" data-act="del">削除</button>
        </div>
      </div>
    `;
    row.querySelectorAll(".mini").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        const act=btn.dataset.act;
        if (act==="del"){
          URL.revokeObjectURL(it.url);
          items.splice(idx,1);
          renderList(); rebuildTiming();
        } else if (act==="up" && idx>0){
          [items[idx-1],items[idx]]=[items[idx],items[idx-1]];
          renderList(); rebuildTiming();
        } else if (act==="down" && idx<items.length-1){
          [items[idx+1],items[idx]]=[items[idx],items[idx+1]];
          renderList(); rebuildTiming();
        }
      });
    });
    row.addEventListener("dragstart",(e)=>{ row.classList.add("dragging"); e.dataTransfer.setData("text/plain", row.dataset.index); });
    row.addEventListener("dragend",()=>row.classList.remove("dragging"));
    row.addEventListener("dragover",(e)=>{ e.preventDefault(); });
    row.addEventListener("drop",(e)=>{
      e.preventDefault();
      const from=Number(e.dataTransfer.getData("text/plain"));
      const to=Number(row.dataset.index);
      if (!Number.isFinite(from)||!Number.isFinite(to)||from===to) return;
      const moved=items.splice(from,1)[0];
      items.splice(to,0,moved);
      renderList(); rebuildTiming();
    });
    imgList.appendChild(row);
  });
}

// ========= load =========
function loadImage(url){
  return new Promise((resolve, reject)=>{
    const img = new Image();
    img.decoding="async";
    img.onload=()=>resolve(img);
    img.onerror=reject;
    img.src=url;
  });
}

imgInput.addEventListener("change", async ()=>{
  clearDownloads();
  const files=[...imgInput.files||[]];
  for (let i=0; i<files.length; i++){
    const f = files[i];
    const url=URL.createObjectURL(f);
    const img=await loadImage(url);
    items.push({
      id: makeId(),
      name: f.name,
      url,
      img,
      seed: hash01(Date.now()+i*97+files.length*13)
    });
  }
  imgInput.value="";
  logLine(`✅ 画像 ${files.length}枚 追加（合計${items.length}）`);
  renderList();
  rebuildTiming();
});

audInput.addEventListener("change", ()=>{
  clearDownloads();
  audioFile = (audInput.files||[])[0] || null;
  if (!audioFile) return;

  const url = URL.createObjectURL(audioFile);
  audioEl.src=url;
  audioEl.load();

  audioEl.onloadedmetadata = ()=>{
    T = audioEl.duration || 0;
    audLenEl.textContent = `${fmtTime(T)}（${T.toFixed(2)}s）`;
    logLine(`✅ 音源 ${audioFile.name} ${T.toFixed(2)}s`);
    rebuildTiming();
  };
});

audioEl.addEventListener("error", ()=>{
  const code = audioEl.error?.code;
  const map = {1:"読み込み中止",2:"ネットワーク",3:"デコード失敗(形式?)",4:"非対応形式"};
  logLine(`❌ 音源エラー: ${map[code]||"不明"} (code=${code??"?"})`);
});

// ========= draw =========
function drawBackground(t, tailStill){
  const r = stage.getBoundingClientRect();
  const W=r.width, H=r.height;

  const th = bgTheme(t);
  const g = ctx.createLinearGradient(0,0,W,H);
  g.addColorStop(0, `hsl(${th.hue} 60% ${tailStill?12:14}%)`);
  g.addColorStop(1, `hsl(${th.hue2} 55% ${tailStill?10:12}%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0,0,cv.width,cv.height);

  // spotlight sweep
  const sweep = (t*0.06) % 1;
  const cx = W * (0.2 + 0.8*sweep);
  const cy = H * (0.35 + 0.08*Math.sin(t*0.4));
  const rr = Math.max(W,H) * 0.65;

  const rad = ctx.createRadialGradient(cx,cy,0,cx,cy,rr);
  const a = tailStill ? 0.07 : 0.11;
  rad.addColorStop(0, `rgba(255,255,255,${a})`);
  rad.addColorStop(1, `rgba(0,0,0,0)`);
  ctx.fillStyle = rad;
  ctx.fillRect(0,0,cv.width,cv.height);
}

function drawParticles(t, tailStill){
  const r = stage.getBoundingClientRect();
  const W=r.width, H=r.height;

  const alphaMul = tailStill ? 0.55 : 1.0;

  ctx.save();
  ctx.globalCompositeOperation = "screen";
  for (const p of particles){
    const x = (p.x + (t*p.sp)) % 1;
    const y = (p.y + Math.sin(t*0.2 + p.x*12)*p.drift);
    const yy = y - Math.floor(y);

    const px = x*W;
    const py = yy*H;

    ctx.globalAlpha = p.a * alphaMul;
    ctx.fillStyle = "rgba(255,255,255,1)";
    ctx.beginPath();
    ctx.arc(px, py, p.r, 0, Math.PI*2);
    ctx.fill();
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

function drawMarquee(offsetX, t, tailStill){
  const r = stage.getBoundingClientRect();
  const W = r.width, H = r.height;
  if (items.length===0) return;

  const imgH = H*0.78;
  const y = (H-imgH)/2;
  const gap = 34;

  const driftY = (tailStill ? 0.25 : 0.65) * Math.sin(t*0.35);

  let x = offsetX;

  for (let i=0; i<items.length; i++){
    const it = items[i];
    const img = it.img;

    const iw=img.width, ih=img.height;
    let drawW = imgH*(iw/ih);
    if (fitModeEl.value==="cover") drawW *= 1.08;

    // 微ケンバーンズ
    const wob = Math.sin(t*0.22 + i*0.7 + it.seed*10);
    const zoom = 1 + (tailStill ? 0.001 : 0.004) * wob;
    const rot = (tailStill ? 0.0006 : 0.0018) * wob;

    if (x + drawW >= -140 && x <= W + 140){
      ctx.save();
      ctx.translate(x + drawW/2, y + imgH/2 + driftY);
      ctx.rotate(rot);
      ctx.scale(zoom, zoom);

      ctx.drawImage(img, -drawW/2, -imgH/2, drawW, imgH);

      // 微妙な露出揺れ（ほんの少しだけ）
      if (!tailStill){
        const bright = 1.0 + 0.015*Math.sin(t*0.6 + i*0.9);
        ctx.globalAlpha = 0.06 * Math.max(0, bright-1);
        ctx.fillStyle = "#fff";
        ctx.fillRect(-drawW/2, -imgH/2, drawW, imgH);
        ctx.globalAlpha = 1;
      }

      ctx.restore();
    }

    x += drawW + gap;
    if (x > W + 220) break;
  }
}

function drawOrb(dt, tailStill){
  if (orbOnEl.value!=="on") return;

  const r = stage.getBoundingClientRect();
  const W=r.width, H=r.height;

  const size=Math.min(120, W*0.14);
  const pad=18;
  const cx=W-pad-size/2;
  const cy=H-pad-size/2;

  // たまに止まる（tail中は止めない）
  if (orbFreeze <= 0 && !tailStill){
    if (Math.random() < 0.008) orbFreeze = 0.35 + Math.random()*0.55;
  }
  if (orbFreeze > 0){
    orbFreeze -= dt;
  } else {
    orbPhase += dt*(0.9);
  }

  const breathe = 1 + 0.03*Math.sin(orbPhase);
  const rot = (orbFreeze>0 ? 0 : 1) * 0.18*Math.sin(orbPhase*0.6);

  ctx.save();
  ctx.translate(cx,cy);
  ctx.rotate(rot);
  ctx.scale(breathe, breathe*0.98);

  ctx.globalAlpha = 0.22;
  ctx.fillStyle="#000";
  ctx.beginPath();
  ctx.ellipse(0,size*0.42,size*0.34,size*0.10,0,0,Math.PI*2);
  ctx.fill();

  const g=ctx.createRadialGradient(-size*0.18,-size*0.18,size*0.12,0,0,size*0.62);
  g.addColorStop(0,"rgba(255,255,255,0.80)");
  g.addColorStop(0.35,"rgba(170,180,210,0.55)");
  g.addColorStop(1,"rgba(35,38,58,0.92)");

  ctx.globalAlpha=0.92;
  ctx.fillStyle=g;
  ctx.beginPath();
  ctx.arc(0,0,size*0.40,0,Math.PI*2);
  ctx.fill();

  ctx.globalAlpha=0.16;
  ctx.fillStyle="#fff";
  ctx.beginPath();
  ctx.ellipse(-size*0.12,-size*0.15,size*0.13,size*0.08,-0.6,0,Math.PI*2);
  ctx.fill();

  ctx.restore();
  ctx.globalAlpha=1;
}

function drawVignette(){
  const r=stage.getBoundingClientRect();
  const W=r.width, H=r.height;
  const g=ctx.createRadialGradient(W*0.5,H*0.5,Math.min(W,H)*0.35,W*0.5,H*0.5,Math.max(W,H)*0.72);
  g.addColorStop(0,"rgba(0,0,0,0)");
  g.addColorStop(1,"rgba(0,0,0,0.62)");
  ctx.fillStyle=g;
  ctx.fillRect(0,0,cv.width,cv.height);
}

// ========= loop =========
function renderFrame(ts){
  if (!playing) return;

  if (!lastTs) lastTs = ts;
  const dtRaw = (ts - lastTs)/1000;
  lastTs = ts;

  accum += dtRaw;
  if (accum < 1/FPS){
    raf = requestAnimationFrame(renderFrame);
    return;
  }
  const dt = accum;
  accum = 0;

  const tCurrent = (!audioEl.paused && Number.isFinite(audioEl.currentTime)) ? audioEl.currentTime : (tMono + dt);
  tMono = Math.max(tMono, tCurrent);

  badge.textContent = `${tMono.toFixed(1)}s`;
  if (T>0) bar.style.width = `${(clamp(tMono/T,0,1)*100).toFixed(2)}%`;

  const Tg = Math.max(0.5, T - END_LEAD_SEC);
  const tailStill = (tMono >= Tg);
  const tMove = Math.min(tMono, Tg);

  const dist = pps * tMove;
  const offsetX = -Math.min(dist, baseDistance);

  setState(tailStill ? "TAIL (still)" : "MOVE (const)");

  drawBackground(tMono, tailStill);
  drawParticles(tMono, tailStill);
  drawMarquee(offsetX, tMono, tailStill);
  drawOrb(dt, tailStill);
  drawVignette();

  raf = requestAnimationFrame(renderFrame);
}

// ========= recording =========
function pickMimeType(){
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm"
  ];
  for (const t of candidates){
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

async function startPreview(){
  if (items.length===0){ alert("画像を入れて"); return; }
  if (!audioFile){ alert("音源を入れて"); return; }
  if (!pps || baseDistance<=0){ alert("計算できてない（画像/音源を入れ直して）"); return; }

  clearDownloads();
  generating = false;

  playing = true;
  tMono = 0;
  orbPhase = 0;
  orbFreeze = 0;
  lastTs = 0;
  accum = 0;

  audioEl.currentTime = 0;
  await audioEl.play();

  setStatus("PREVIEW");
  raf = requestAnimationFrame(renderFrame);
}

async function startGenerate(){
  if (items.length===0){ alert("画像を入れて"); return; }
  if (!audioFile){ alert("音源を入れて"); return; }
  if (!pps || baseDistance<=0){ alert("計算できてない（画像/音源を入れ直して）"); return; }
  if (typeof cv.captureStream !== "function"){ alert("この環境はcaptureStream未対応。Chrome推奨。"); return; }
  if (!window.MediaRecorder){ alert("この環境はMediaRecorder未対応。Chrome推奨。"); return; }

  clearDownloads();

  playing = true;
  generating = true;
  tMono = 0;
  orbPhase = 0;
  orbFreeze = 0;
  lastTs = 0;
  accum = 0;

  const canvasStream = cv.captureStream(FPS);

  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const src = audioCtx.createMediaElementSource(audioEl);
  const dest = audioCtx.createMediaStreamDestination();
  src.connect(dest);
  src.connect(audioCtx.destination);

  const mixed = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...dest.stream.getAudioTracks()
  ]);

  const mime = pickMimeType();
  recorder = new MediaRecorder(mixed, mime ? { mimeType: mime } : undefined);

  recChunks = [];
  recorder.ondataavailable = (e)=>{ if (e.data && e.data.size>0) recChunks.push(e.data); };
  recorder.onstop = ()=>{
    const blob = new Blob(recChunks, { type: recorder.mimeType || "video/webm" });
    const url = URL.createObjectURL(blob);
    dlLink.href = url;
    dlLink.style.display = "inline-flex";
    dlLink.textContent = "ダウンロード（WebM）";
    setStatus("DONE");
    logLine("✅ 生成完了（WebM）");
  };

  recorder.start(250);

  audioEl.currentTime = 0;
  await audioEl.play();

  setStatus("GENERATING");
  logLine(`✅ generate start mime=${recorder.mimeType||"(default)"}`);

  raf = requestAnimationFrame(renderFrame);

  audioEl.onended = ()=>{
    stopAll(true);
  };
}

function stopAll(fromEnded=false){
  playing = false;
  cancelAnimationFrame(raf);
  raf = 0;
  lastTs = 0;
  accum = 0;

  try{ audioEl.pause(); }catch{}
  audioEl.currentTime = 0;

  if (generating && recorder && recorder.state==="recording"){
    try{ recorder.requestData(); }catch{}
    recorder.stop();
  }
  generating = false;

  if (!fromEnded){
    setStatus("STOPPED");
    setState("IDLE");
  }
}

// ========= buttons =========
btnPreview.addEventListener("click", ()=>startPreview().catch(e=>logLine(`❌ preview: ${e?.message||e}`)));
btnGenerate.addEventListener("click", ()=>startGenerate().catch(e=>logLine(`❌ generate: ${e?.message||e}`)));
btnAbort.addEventListener("click", ()=>stopAll(false));
btnFS.addEventListener("click", async ()=>{
  if (!document.fullscreenElement) await stage.requestFullscreen?.();
  else await document.exitFullscreen?.();
});

// ========= init =========
setStatus("READY");
setState("IDLE");
initParticles();
renderList();
logLine("✅ 起動完了（ステッカー無し）");
