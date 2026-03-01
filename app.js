"use strict";

/**
 * A版（推奨）：リアルタイムだけど“ワンクリック自動生成”
 * - offsetXは「音源時間から直接」算出 → 戻らない/逆走しない
 * - endLead秒前に流れ切る（Tgで速度計算）
 * - 30fps描画 / FFTは3フレに1回 / 描画枚数少なめ
 * - 生成ボタンで：録画開始→最初から再生→終端で自動停止→DL表示
 */

const $ = (id) => document.getElementById(id);
const logEl = $("log");
function logLine(msg){
  const t = new Date().toLocaleTimeString();
  if (logEl) logEl.textContent = `[${t}] ${msg}\n` + logEl.textContent;
}
function safe(fn, label){
  try { return fn(); }
  catch(e){
    logLine(`❌ ${label}: ${e?.message || e}`);
    console.error(label, e);
    return undefined;
  }
}
window.addEventListener("error", (e) => logLine(`❌ window.error: ${e.message} @${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => logLine(`❌ unhandledrejection: ${e.reason?.message || e.reason}`));

function must(id){
  const el = $(id);
  if (!el) throw new Error(`Element not found: #${id}`);
  return el;
}
const clamp = (v,a,b) => Math.max(a, Math.min(b,v));
const fmtTime = (s) => {
  if (!Number.isFinite(s)) return "-";
  const m = Math.floor(s/60);
  const ss = Math.floor(s%60).toString().padStart(2,"0");
  return `${m}:${ss}`;
};

const imgInput = must("imgInput");
const audInput = must("audInput");
const imgList  = must("imgList");

const audioEl  = must("audio");
const audLenEl = must("audLen");
const loopsEl  = must("loops");

const btnGenerate = must("btnGenerate");
const btnPreview = must("btnPreview");
const btnStop  = must("btnStop");
const btnFS    = must("btnFS");
const btnAbort = must("btnAbort");

const dlLink   = must("dlLink");

const stage    = must("stage");
const cv       = must("cv");
const ctx      = cv.getContext("2d", { alpha:false });

const statusPill = must("statusPill");
const badge = must("badge");
const bar = must("bar");
const speedBadge = must("speedBadge");

const flowStrengthEl = must("flowStrength");
const spiceEl = must("spice");
const fitModeEl = must("fitMode");
const orbOnEl = must("orbOn");
const endLeadEl = must("endLead");

let items = []; // {id, name, url, img}
let playing = false;
let paused = false;

let raf = 0;
let lastTs = 0;

let audioCtx = null;
let analyser = null;
let audioSrcNode = null;
let freqData = null;

let baseCycleW = 0;  // items 1セット幅（CSS px換算）
let basePps = 40;    // px/sec（effectiveTime=1秒あたり）
let loops = 1;
let T = 0;

// perf
const TARGET_FPS = 30;
let accum = 0;
let energySmoothed = 0;
let energyTick = 0;

// orb
let orb = { phase:0, spin:0, pop:0, cd:0 };

// recorder
let recorder = null;
let recChunks = [];
let generating = false;

function setStatus(s){ statusPill.textContent = s; }
function revokeUrl(url){ try{ URL.revokeObjectURL(url); } catch{} }
function clearDownloads(){ dlLink.style.display="none"; dlLink.href="#"; }
function makeId(){
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return "id_" + Math.random().toString(16).slice(2) + "_" + Date.now().toString(16);
}
function currentMultiplier(t){ return (t < 60) ? 0.9 : 1.0; }

// --- canvas fixed 1920x1080 ---
let resizePending = false;
function resizeCanvasSafe(){
  const r = stage.getBoundingClientRect();
  const cssW = Math.floor(r.width);
  const cssH = Math.floor(r.height);
  if (!Number.isFinite(cssW) || !Number.isFinite(cssH) || cssW <= 0 || cssH <= 0) return;

  const TARGET_W = 1920;
  const TARGET_H = 1080;

  if (cv.width !== TARGET_W) cv.width = TARGET_W;
  if (cv.height !== TARGET_H) cv.height = TARGET_H;

  const sx = TARGET_W / cssW;
  const sy = TARGET_H / cssH;
  ctx.setTransform(sx,0,0,sy,0,0);
}
function requestResize(){
  if (resizePending) return;
  resizePending = true;
  requestAnimationFrame(() => {
    resizePending = false;
    safe(resizeCanvasSafe, "resizeCanvasSafe");
  });
}
const ro = new ResizeObserver(() => requestResize());
ro.observe(stage);
window.addEventListener("resize", requestResize);
document.addEventListener("fullscreenchange", requestResize);
requestResize();

// --- audio error ---
audioEl.addEventListener("error", () => {
  const code = audioEl.error?.code;
  const map = {1:"読み込み中止",2:"ネットワークエラー",3:"デコード失敗(形式?)",4:"サポート外形式"};
  logLine(`❌ 音源エラー: ${map[code]||"不明"} (code=${code ?? "?"})`);
});

// --- list UI ---
function renderList(){
  imgList.innerHTML = "";
  if (items.length === 0){
    const empty = document.createElement("div");
    empty.className = "hint";
    empty.textContent = "画像がまだない。画像→音源→生成開始。";
    imgList.appendChild(empty);
    return;
  }

  items.forEach((it, idx) => {
    const row = document.createElement("div");
    row.className = "item";
    row.draggable = true;
    row.dataset.index = String(idx);

    row.innerHTML = `
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

    row.querySelectorAll(".mini").forEach(btn => {
      btn.addEventListener("click", () => safe(() => {
        const act = btn.dataset.act;
        if (act === "del"){
          revokeUrl(it.url);
          items.splice(idx, 1);
          renderList();
          rebuildAndSync();
          return;
        }
        if (act === "up" && idx > 0){
          [items[idx-1], items[idx]] = [items[idx], items[idx-1]];
          renderList();
          rebuildAndSync();
          return;
        }
        if (act === "down" && idx < items.length - 1){
          [items[idx+1], items[idx]] = [items[idx], items[idx+1]];
          renderList();
          rebuildAndSync();
          return;
        }
      }, "list"));
    });

    row.addEventListener("dragstart", (e) => {
      row.classList.add("dragging");
      e.dataTransfer.setData("text/plain", row.dataset.index);
      e.dataTransfer.effectAllowed = "move";
    });
    row.addEventListener("dragend", () => row.classList.remove("dragging"));
    row.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect="move"; });
    row.addEventListener("drop", (e) => safe(() => {
      e.preventDefault();
      const from = Number(e.dataTransfer.getData("text/plain"));
      const to = Number(row.dataset.index);
      if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return;
      const moved = items.splice(from, 1)[0];
      items.splice(to, 0, moved);
      renderList();
      rebuildAndSync();
    }, "drop"));
    imgList.appendChild(row);
  });
}

// --- image load ---
function loadImage(url){
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}
imgInput.addEventListener("change", () => safe(async () => {
  clearDownloads();
  const files = Array.from(imgInput.files || []);
  if (files.length === 0) return;
  for (const f of files){
    const url = URL.createObjectURL(f);
    const img = await loadImage(url);
    items.push({ id: makeId(), name: f.name, url, img });
  }
  imgInput.value = "";
  logLine(`✅ 画像追加: ${files.length}枚 / 合計${items.length}枚`);
  renderList();
  rebuildAndSync();
}, "imgInput"));

// --- audio load ---
audInput.addEventListener("change", () => safe(() => {
  clearDownloads();
  const f = (audInput.files || [])[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  audioEl.src = url;
  audioEl.load();
  audioEl.onloadedmetadata = () => safe(() => {
    T = audioEl.duration || 0;
    audLenEl.textContent = `${fmtTime(T)}（${T.toFixed(2)}s）`;
    logLine(`✅ 音源読み込み: ${f.name} / ${T.toFixed(2)}s`);
    rebuildAndSync();
  }, "metadata");
}, "audInput"));

// --- sync calc ---
function pickLoopsAuto(durationSec){
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 1;
  if (durationSec < 80) return 1;
  if (durationSec < 160) return 2;
  if (durationSec < 240) return 3;
  return 4;
}

function estimateCycleWidthForItems(){
  if (items.length === 0) return 0;
  const r = stage.getBoundingClientRect();
  const H = r.height;
  const imgH = H * 0.78;
  const gap = 34;

  let w = 0;
  for (const it of items){
    const iw = it.img?.width || 1000;
    const ih = it.img?.height || 1000;
    let drawW = imgH * (iw/ih);
    if (fitModeEl.value === "cover") drawW *= 1.08;
    w += drawW + gap;
  }
  return w;
}

function rebuildAndSync(){
  baseCycleW = estimateCycleWidthForItems();
  const chosen = loopsEl.value === "auto" ? String(pickLoopsAuto(T)) : loopsEl.value;
  loops = Number(chosen) || 1;

  if (T > 0 && baseCycleW > 0){
    const lead = Number(endLeadEl.value || 0) || 0;
    const Tg = Math.max(0.5, T - lead);

    const a = Math.min(60, Tg);
    const b = Math.max(0, Tg - 60);
    const effective = 0.9*a + 1.0*b;

    basePps = (baseCycleW * loops) / Math.max(0.001, effective);

    const W = Math.max(1, stage.getBoundingClientRect().width);
    basePps = clamp(basePps, W*0.0016, W*0.028);

    logLine(`✅ 同期: lead=${lead.toFixed(1)} Tg=${Tg.toFixed(2)} loops=${loops} basePps=${basePps.toFixed(2)} cycleW=${baseCycleW.toFixed(1)}`);
    setStatus("SYNCED");
  } else if (items.length > 0) {
    setStatus("IMAGES OK");
  } else {
    setStatus("READY");
  }
}
["input","change"].forEach(ev => {
  endLeadEl.addEventListener(ev, () => safe(rebuildAndSync, "sync"));
  flowStrengthEl.addEventListener(ev, () => safe(rebuildAndSync, "sync"));
  spiceEl.addEventListener(ev, () => {});
  fitModeEl.addEventListener(ev, () => safe(rebuildAndSync, "sync"));
  loopsEl.addEventListener(ev, () => safe(rebuildAndSync, "sync"));
});

// --- audio analysis ---
async function ensureAudioAnalysis(){
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.85;
  freqData = new Uint8Array(analyser.frequencyBinCount);

  audioSrcNode = audioCtx.createMediaElementSource(audioEl);
  audioSrcNode.connect(analyser);
  analyser.connect(audioCtx.destination);
  logLine("✅ AudioContext ready");
}
function getEnergy(){
  if (!analyser || !freqData) return 0;
  analyser.getByteFrequencyData(freqData);
  const n = freqData.length;
  const start = Math.floor(n * 0.02);
  const end = Math.floor(n * 0.18);
  let sum = 0;
  for (let i=start;i<end;i++) sum += freqData[i];
  return (sum / Math.max(1,(end-start))) / 255;
}

// --- draw helpers ---
function effectiveTimeFromAudio(tAudio){
  const t1 = Math.min(60, tAudio);
  const t2 = Math.max(0, tAudio - 60);
  return 0.9*t1 + 1.0*t2;
}

function drawFrame(ts){
  if (!playing){ return; }
  if (!lastTs) lastTs = ts;
  const dtRaw = (ts - lastTs)/1000;
  lastTs = ts;

  accum += dtRaw;
  if (accum < 1/TARGET_FPS){
    raf = requestAnimationFrame(drawFrame);
    return;
  }
  const dt = accum;
  accum = 0;

  const tAudio = (!audioEl.paused && Number.isFinite(audioEl.currentTime))
    ? audioEl.currentTime
    : (badge._t || 0) + dt;
  badge._t = tAudio;

  const mul = currentMultiplier(tAudio);
  speedBadge.textContent = `x${mul.toFixed(2)}`;

  // progress bar
  if (T > 0) bar.style.width = `${(clamp(tAudio/T,0,1)*100).toFixed(2)}%`;
  else bar.style.width = "0%";
  badge.textContent = `${tAudio.toFixed(1)}s`;

  // --- offsetXは「音源時間」から直接算出 → 戻らない
  const flowMul = Number(flowStrengthEl.value) || 1.0;
  const eff = effectiveTimeFromAudio(tAudio);
  const dist = basePps * flowMul * eff;

  const m = (baseCycleW > 0) ? (dist % baseCycleW) : 0;
  const offsetX = -m; // left

  // energy (3フレに1回)
  let energy = 0;
  const spice = Number(spiceEl.value) || 0;
  if (audioCtx && !audioEl.paused){
    energyTick = (energyTick + 1) % 3;
    if (energyTick === 0){
      energySmoothed = 0.7*energySmoothed + 0.3*getEnergy();
    }
    energy = energySmoothed;
  }

  // background
  const flash = spice * 0.06 * (energy ** 1.6);
  ctx.fillStyle = `rgb(${Math.floor(7+flash*30)},${Math.floor(7+flash*18)},${Math.floor(11+flash*36)})`;
  ctx.fillRect(0,0,cv.width,cv.height);

  drawMarquee(tAudio, spice, offsetX);

  if (orbOnEl.value === "on"){
    drawOrb(tAudio, dt, spice, energy);
  }
  drawVignette();

  raf = requestAnimationFrame(drawFrame);
}

function drawMarquee(t, spice, offsetX){
  const r = stage.getBoundingClientRect();
  const W = r.width;
  const H = r.height;
  if (items.length === 0) return;

  const imgH = H * 0.78;
  const y = (H - imgH)/2;

  const gapBase = 34;
  const gapPulse = spice * 6 * (0.5 - Math.abs(((t*0.15)%1)-0.5)*2);
  const gap = gapBase + gapPulse;

  const micro = 1 + spice * 0.018 * Math.sin(t*0.55) + spice * 0.010 * Math.sin(t*1.1+1.2);
  const driftY = spice * 1.2 * Math.sin(t*0.35);

  let x = offsetX;
  if (baseCycleW > 0 && x > 0) x -= baseCycleW;

  const maxCycles = 2;
  for (let c=0; c<maxCycles; c++){
    for (let i=0; i<items.length; i++){
      const it = items[i];
      const img = it.img;
      if (!img) continue;

      const iw = img.width, ih = img.height;
      let drawW = imgH * (iw/ih);
      if (fitModeEl.value === "cover") drawW *= 1.08;

      if (x + drawW >= -120 && x <= W + 120){
        const local = 0.007 * Math.sin(t*0.6 + (i + c*items.length)*0.8) * spice;
        const z = (1 + local) * micro;

        ctx.save();
        ctx.translate(x + drawW/2, y + imgH/2 + driftY);
        ctx.scale(z, z);
        ctx.drawImage(img, -drawW/2, -imgH/2, drawW, imgH);
        ctx.restore();
      }

      x += drawW + gap;
      if (x > W + 120) break;
    }
    if (x > W + 120) break;
  }
}

function drawOrb(t, dt, spice, energy){
  const r = stage.getBoundingClientRect();
  const W = r.width;
  const H = r.height;

  const size = Math.min(120, W*0.14);
  const pad = 18;
  const cx = W - pad - size/2;
  const cy = H - pad - size/2;

  orb.phase += dt * (0.9 + spice*0.2);
  orb.spin += dt * 0.2;

  if (orb.cd > 0) orb.cd -= dt;
  const peak = (energy > 0.55 + (1-spice)*0.1) && orb.cd <= 0 && spice > 0.05;
  if (peak){
    orb.pop = 1.0;
    orb.cd = 0.6;
    orb.spin += 0.7;
  } else {
    orb.pop = Math.max(0, orb.pop - dt*2.4);
  }

  const breathe = 1 + 0.03*Math.sin(orb.phase);
  const popScale = 1 + orb.pop*0.07;
  const rot = 0.20*Math.sin(orb.spin) + orb.pop*0.16;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  ctx.scale(breathe*popScale, (breathe*0.98)*popScale);

  ctx.globalAlpha = 0.24;
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.ellipse(0, size*0.42, size*0.34, size*0.10, 0, 0, Math.PI*2);
  ctx.fill();

  const g = ctx.createRadialGradient(-size*0.18, -size*0.18, size*0.12, 0, 0, size*0.62);
  g.addColorStop(0, "rgba(255,255,255,0.80)");
  g.addColorStop(0.35, "rgba(170,180,210,0.55)");
  g.addColorStop(1, "rgba(35,38,58,0.92)");

  ctx.globalAlpha = 0.92;
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0,0,size*0.40,0,Math.PI*2);
  ctx.fill();

  ctx.globalAlpha = 0.18;
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.ellipse(-size*0.12, -size*0.15, size*0.13, size*0.08, -0.6, 0, Math.PI*2);
  ctx.fill();

  ctx.restore();
  ctx.globalAlpha = 1;
}

function drawVignette(){
  const r = stage.getBoundingClientRect();
  const W = r.width;
  const H = r.height;
  const g = ctx.createRadialGradient(W*0.5, H*0.5, Math.min(W,H)*0.35, W*0.5, H*0.5, Math.max(W,H)*0.72);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,0,0,0.62)");
  ctx.fillStyle = g;
  ctx.fillRect(0,0,cv.width,cv.height);
}

// --- audio analysis setup ---
async function prepareAudio(){
  await ensureAudioAnalysis();
  if (audioCtx.state === "suspended") await audioCtx.resume();
}

// --- generate (record) ---
function pickMimeType(){
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm"
  ];
  for (const t of candidates){
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

async function startGenerate(){
  if (generating) return;
  if (items.length === 0){ alert("先に画像を追加して順番を決めて。"); return; }
  if (!audioEl.src){ alert("次に音源をアップロードして。"); return; }
  if (typeof cv.captureStream !== "function"){ alert("この環境はcanvas.captureStream未対応。Chrome推奨。"); return; }
  if (!window.MediaRecorder){ alert("この環境はMediaRecorder未対応。Chrome推奨。"); return; }

  clearDownloads();
  await prepareAudio();

  rebuildAndSync();

  // start drawing
  playing = true;
  paused = false;
  lastTs = 0;
  accum = 0;
  badge._t = 0;
  energySmoothed = 0;
  energyTick = 0;

  // audio start
  audioEl.currentTime = 0;
  try{ await audioEl.play(); }
  catch(e){
    logLine(`❌ 再生失敗: ${e?.message || e}`);
    alert("音源の再生に失敗（形式/権限）。");
    playing = false;
    return;
  }

  // streams
  const canvasStream = cv.captureStream(30);
  const dest = audioCtx.createMediaStreamDestination();
  try{ audioSrcNode.disconnect(); }catch{}
  audioSrcNode.connect(analyser);
  audioSrcNode.connect(dest);

  const mixed = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...dest.stream.getAudioTracks()
  ]);

  const mimeType = pickMimeType();
  try{
    recorder = new MediaRecorder(mixed, mimeType ? { mimeType } : undefined);
  }catch(e){
    logLine(`❌ MediaRecorder ctor失敗: ${e?.message || e}`);
    alert("録画作成に失敗。Chrome推奨。");
    playing = false;
    return;
  }

  recChunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) recChunks.push(e.data); };
  recorder.onerror = (e) => logLine(`❌ recorder error: ${e?.error?.message || e?.message || e}`);
  recorder.onstop = () => safe(() => {
    const blob = new Blob(recChunks, { type: recorder.mimeType || "video/webm" });
    const url = URL.createObjectURL(blob);
    dlLink.href = url;
    dlLink.style.display = "inline-flex";
    dlLink.textContent = "ダウンロード（WebM）";
    setStatus("DONE");
    logLine("✅ 生成完了（WebM）");
  }, "recorder.onstop");

  generating = true;
  setStatus("GENERATING");
  logLine(`✅ 生成開始 mime=${recorder.mimeType || "(default)"}`);

  recorder.start(300);

  // stop at end
  audioEl.onended = () => {
    stopGenerateInternal(true);
  };

  raf = requestAnimationFrame(drawFrame);
}

function stopGenerateInternal(auto){
  if (recorder && recorder.state === "recording"){
    try{ recorder.requestData(); }catch{}
    recorder.stop();
  }
  generating = false;

  // stop playback
  playing = false;
  cancelAnimationFrame(raf);
  raf = 0;
  lastTs = 0;
  accum = 0;

  try{ audioEl.pause(); }catch{}
  audioEl.currentTime = 0;

  if (!auto) setStatus("STOPPED");
}

function abortGenerate(){
  if (!generating){
    stopPreview();
    return;
  }
  stopGenerateInternal(false);
}

function stopPreview(){
  playing = false;
  cancelAnimationFrame(raf);
  raf = 0;
  lastTs = 0;
  accum = 0;
  try{ audioEl.pause(); }catch{}
  audioEl.currentTime = 0;
  setStatus("STOPPED");
}

// --- preview ---
async function startPreview(){
  if (items.length === 0){ alert("先に画像を追加して順番を決めて。"); return; }
  if (!audioEl.src){ alert("次に音源をアップロードして。"); return; }

  await prepareAudio();
  rebuildAndSync();

  playing = true;
  paused = false;
  lastTs = 0;
  accum = 0;
  badge._t = 0;

  audioEl.currentTime = 0;
  try{ await audioEl.play(); }
  catch(e){
    logLine(`❌ 再生失敗: ${e?.message || e}`);
    alert("音源の再生に失敗。");
    playing = false;
    return;
  }

  setStatus("PREVIEW");
  raf = requestAnimationFrame(drawFrame);
}

// --- controls ---
btnGenerate.addEventListener("click", () => safe(startGenerate, "startGenerate"));
btnPreview.addEventListener("click", () => safe(startPreview, "startPreview"));
btnStop.addEventListener("click", () => safe(() => { generating=false; stopPreview(); }, "stop"));
btnAbort.addEventListener("click", () => safe(abortGenerate, "abort"));
btnFS.addEventListener("click", () => safe(async () => {
  if (!document.fullscreenElement) await stage.requestFullscreen?.();
  else await document.exitFullscreen?.();
}, "fs"));

// --- init ---
setStatus("READY");
renderList();
rebuildAndSync();
logLine("✅ 起動完了（自動生成版）");
