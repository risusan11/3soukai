"use strict";

/**
 * 安全版ポイント
 * - 画面ログ：エラーの原因が必ず画面に出る
 * - 例外は全部catchして落ちない
 * - 速度計算は items 1セット幅のみ（爆速防止）
 * - MediaRecorder / captureStream / Audio 再生 ぜんぶガード
 */

const $ = (id) => document.getElementById(id);
const logEl = $("log");
function logLine(msg){
  const t = new Date().toLocaleTimeString();
  logEl.textContent = `[${t}] ${msg}\n` + logEl.textContent;
}
function safe(fn, label){
  try { return fn(); }
  catch(e){
    logLine(`❌ ${label}: ${e?.message || e}`);
    console.error(label, e);
    return undefined;
  }
}

window.addEventListener("error", (e) => {
  logLine(`❌ window.error: ${e.message} @${e.filename}:${e.lineno}`);
});
window.addEventListener("unhandledrejection", (e) => {
  logLine(`❌ unhandledrejection: ${e.reason?.message || e.reason}`);
});

function must(id){
  const el = $(id);
  if (!el) throw new Error(`Element not found: #${id}`);
  return el;
}

// --- elements (全部存在チェックする) ---
const imgInput = must("imgInput");
const audInput = must("audInput");
const imgList  = must("imgList");

const audioEl  = must("audio");
const audLenEl = must("audLen");
const loopsEl  = must("loops");

const btnPlay  = must("btnPlay");
const btnPause = must("btnPause");
const btnStop  = must("btnStop");
const btnFS    = must("btnFS");

const btnRec   = must("btnRec");
const btnRecStop = must("btnRecStop");
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

// --- state ---
let items = []; // {id, name, url, img}
let playing = false;
let paused = false;
let raf = 0;
let lastTs = 0;

let audioCtx = null;
let analyser = null;
let audioSrcNode = null;
let freqData = null;

let offsetX = 0;
let baseCycleW = 0;  // items 1セットの幅
let basePps = 40;    // px/sec
let loops = 1;
let T = 0;

let recorder = null;
let recChunks = [];

const clamp = (v,a,b) => Math.max(a, Math.min(b,v));
const fmtTime = (s) => {
  if (!Number.isFinite(s)) return "-";
  const m = Math.floor(s/60);
  const ss = Math.floor(s%60).toString().padStart(2,"0");
  return `${m}:${ss}`;
};
function setStatus(text){ statusPill.textContent = text; }
function revokeUrl(url){ try{ URL.revokeObjectURL(url); } catch {} }
function clearDownloads(){
  dlLink.style.display = "none";
  dlLink.href = "#";
}
function currentMultiplier(t){
  return (t < 60) ? 0.9 : 1.0;
}
function makeId(){
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return "id_" + Math.random().toString(16).slice(2) + "_" + Date.now().toString(16);
}

// --- canvas resize (NO LOOP / FIXED 16:9) ---
let resizePending = false;

function resizeCanvasSafe(){
  const r = stage.getBoundingClientRect();
  const cssW = Math.floor(r.width);
  const cssH = Math.floor(r.height);
  if (!Number.isFinite(cssW) || !Number.isFinite(cssH) || cssW <= 0 || cssH <= 0) return;

  // 目的：見た目はCSSで100%フィット、内部解像度は「録画向け」に固定
  // ここを変えるだけで 4K/フルHD切替できる
  const TARGET_W = 1920;
  const TARGET_H = 1080;

  cv.width = TARGET_W;
  cv.height = TARGET_H;

  // CSSサイズに合わせて描画をスケール（座標系をCSSピクセル基準にする）
  const sx = TARGET_W / cssW;
  const sy = TARGET_H / cssH;
  ctx.setTransform(sx, 0, 0, sy, 0, 0);

  // ログ（うるさければ消してOK）
  // logLine(`ℹ️ canvas fixed: css=${cssW}x${cssH} px=${TARGET_W}x${TARGET_H}`);
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

// --- audio error visible ---
audioEl.addEventListener("error", () => {
  const code = audioEl.error?.code;
  const map = {
    1: "読み込み中止",
    2: "ネットワークエラー",
    3: "デコード失敗（形式非対応の可能性）",
    4: "サポート外形式の可能性"
  };
  logLine(`❌ 音源エラー: ${map[code] || "不明"} (code=${code ?? "?"})`);
});

// --- list UI ---
function renderList(){
  imgList.innerHTML = "";
  if (items.length === 0){
    const empty = document.createElement("div");
    empty.className = "hint";
    empty.textContent = "画像がまだない。画像→音源→再生/書き出し。";
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
      }, "list button"));
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
    }, "drop reorder"));

    imgList.appendChild(row);
  });
}

// --- image loading ---
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
}, "imgInput change"));

// --- audio loading ---
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
  }, "onloadedmetadata");
}, "audInput change"));

// --- sync calc ---
function pickLoopsAuto(durationSec){
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 1;
  if (durationSec < 80) return 1;
  if (durationSec < 160) return 2;
  if (durationSec < 240) return 3;
  return 4;
}
loopsEl.addEventListener("change", () => safe(rebuildAndSync, "rebuildAndSync"));
fitModeEl.addEventListener("change", () => safe(rebuildAndSync, "rebuildAndSync"));

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
  offsetX = 0;
  baseCycleW = estimateCycleWidthForItems();

  const chosen = loopsEl.value === "auto" ? String(pickLoopsAuto(T)) : loopsEl.value;
  loops = Number(chosen) || 1;

  if (T > 0 && baseCycleW > 0){
    const a = Math.min(60, T);
    const b = Math.max(0, T - 60);
    const effective = 0.9 * a + 1.0 * b;

    basePps = (baseCycleW * loops) / Math.max(0.001, effective);

    // 爆速防止クランプ（画面幅に対する割合で縛る）
    const W = Math.max(1, stage.getBoundingClientRect().width);
    const minPps = W * 0.0018; // 0.18%/s
    const maxPps = W * 0.030;  // 3.0%/s
    basePps = clamp(basePps, minPps, maxPps);

    setStatus("SYNCED");
    logLine(`✅ 同期: loops=${loops} basePps=${basePps.toFixed(2)} baseCycleW=${baseCycleW.toFixed(1)}`);
  } else if (items.length > 0){
    setStatus("IMAGES OK");
  } else {
    setStatus("READY");
  }
}

// --- audio analysis (created lazily) ---
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
  const avg = sum / Math.max(1, (end-start));
  return avg / 255;
}

// --- render ---
let orb = { phase:0, spin:0, pop:0, cd:0 };

function draw(ts){
  if (!playing) return;
  if (!lastTs) lastTs = ts;
  const dt = (ts - lastTs)/1000;
  lastTs = ts;

  if (!paused){
    const t = (!audioEl.paused && Number.isFinite(audioEl.currentTime))
      ? audioEl.currentTime
      : (badge._t || 0) + dt;

    badge._t = t;

    const mul = currentMultiplier(t);
    const flowMul = Number(flowStrengthEl.value) || 1.0;
    const spice = Number(spiceEl.value) || 0;

    const pps = basePps * mul * flowMul;
    offsetX -= pps * dt;

    if (baseCycleW > 0){
      while (offsetX <= -baseCycleW) offsetX += baseCycleW;
    }

    badge.textContent = `${t.toFixed(1)}s`;
    speedBadge.textContent = `x${mul.toFixed(2)}`;
    if (T > 0) bar.style.width = `${(clamp(t/T,0,1)*100).toFixed(2)}%`;
    else bar.style.width = "0%";

    const energy = (audioCtx && !audioEl.paused) ? getEnergy() : 0;

    const flash = spice * 0.06 * (energy ** 1.6);
    ctx.fillStyle = `rgb(${Math.floor(7+flash*30)},${Math.floor(7+flash*18)},${Math.floor(11+flash*36)})`;
    ctx.fillRect(0,0,cv.width,cv.height);

    drawMarquee(t, spice);
    if (orbOnEl.value === "on") drawOrb(t, dt, spice, energy);
    drawVignette();

    if (Math.random() < 0.01){
      // resize/fitで幅が変わった時の自然補正
      baseCycleW = estimateCycleWidthForItems();
    }
  }

  raf = requestAnimationFrame(draw);
}

function drawMarquee(t, spice){
  const r = stage.getBoundingClientRect();
  const W = r.width;
  const H = r.height;

  if (items.length === 0) return;

  const imgH = H * 0.78;
  const y = (H - imgH)/2;

  const gapBase = 34;
  const gapPulse = spice * 8 * (0.5 - Math.abs(((t*0.15)%1)-0.5)*2);
  const gap = gapBase + gapPulse;

  const micro = 1 + spice * 0.02 * Math.sin(t*0.55) + spice * 0.012 * Math.sin(t*1.1+1.2);
  const driftY = spice * 1.5 * Math.sin(t*0.35);

  let x = offsetX;
  if (baseCycleW > 0 && x > 0) x -= baseCycleW;

  const maxCycles = 4;
  for (let c=0; c<maxCycles; c++){
    for (let i=0; i<items.length; i++){
      const it = items[i];
      const img = it.img;
      if (!img) continue;

      const iw = img.width, ih = img.height;
      let drawW = imgH * (iw/ih);
      if (fitModeEl.value === "cover") drawW *= 1.08;

      if (x + drawW >= -200 && x <= W + 200){
        const local = 0.007 * Math.sin(t*0.6 + (i + c*items.length)*0.8) * spice;
        const z = (1 + local) * micro;

        ctx.save();
        ctx.translate(x + drawW/2, y + imgH/2 + driftY);
        ctx.scale(z, z);
        ctx.drawImage(img, -drawW/2, -imgH/2, drawW, imgH);
        ctx.restore();
      }

      x += drawW + gap;
      if (x > W + 400) break;
    }
    if (x > W + 400) break;
  }
}

function drawOrb(t, dt, spice, energy){
  const r = stage.getBoundingClientRect();
  const W = r.width;
  const H = r.height;

  const size = Math.min(140, W*0.16);
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
    orb.spin += 0.8;
  } else {
    orb.pop = Math.max(0, orb.pop - dt*2.4);
  }

  const breathe = 1 + 0.03*Math.sin(orb.phase) + 0.015*Math.sin(orb.phase*0.7+2);
  const popScale = 1 + orb.pop*0.08;
  const rot = 0.25*Math.sin(orb.spin) + orb.pop*0.2;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  ctx.scale(breathe*popScale, (breathe*0.98)*popScale);

  ctx.globalAlpha = 0.28;
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.ellipse(0, size*0.42, size*0.36, size*0.10, 0, 0, Math.PI*2);
  ctx.fill();

  const g = ctx.createRadialGradient(-size*0.18, -size*0.18, size*0.12, 0, 0, size*0.62);
  g.addColorStop(0, "rgba(255,255,255,0.80)");
  g.addColorStop(0.35, "rgba(170,180,210,0.55)");
  g.addColorStop(1, "rgba(35,38,58,0.92)");

  ctx.globalAlpha = 0.95;
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0,0,size*0.40,0,Math.PI*2);
  ctx.fill();

  ctx.globalAlpha = 0.22;
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

// --- controls ---
btnPlay.addEventListener("click", () => safe(async () => {
  if (items.length === 0){ alert("先に画像を追加して順番を決めて。"); return; }
  if (!audioEl.src){ alert("次に音源をアップロードして。"); return; }

  await ensureAudioAnalysis();
  if (audioCtx.state === "suspended") await audioCtx.resume();

  rebuildAndSync();

  if (!playing){
    playing = true;
    paused = false;
    lastTs = 0;
    setStatus("PLAYING");
    audioEl.currentTime = 0;

    try{ await audioEl.play(); }
    catch(e){
      logLine(`❌ 再生失敗: ${e?.message || e}`);
      alert("音源の再生に失敗。形式が合ってない可能性がある。ログ見て。");
      setStatus("PLAY ERROR");
      playing = false;
      return;
    }

    raf = requestAnimationFrame(draw);
  } else if (paused){
    paused = false;
    setStatus("PLAYING");
    try{ await audioEl.play(); } catch(e){ logLine(`❌ resume失敗: ${e?.message || e}`); }
  }
}, "btnPlay"));

btnPause.addEventListener("click", () => safe(async () => {
  if (!playing) return;
  paused = !paused;
  setStatus(paused ? "PAUSED" : "PLAYING");
  if (paused) audioEl.pause();
  else {
    await ensureAudioAnalysis();
    if (audioCtx.state === "suspended") await audioCtx.resume();
    try{ await audioEl.play(); } catch(e){ logLine(`❌ resume失敗: ${e?.message || e}`); }
  }
}, "btnPause"));

btnStop.addEventListener("click", () => safe(stopAll, "btnStop"));

function stopAll(){
  playing = false;
  paused = false;
  cancelAnimationFrame(raf);
  raf = 0;
  lastTs = 0;
  badge._t = 0;
  bar.style.width = "0%";
  audioEl.pause();
  audioEl.currentTime = 0;
  setStatus("STOPPED");
  ctx.fillStyle = "#000";
  ctx.fillRect(0,0,cv.width,cv.height);
}

btnFS.addEventListener("click", () => safe(async () => {
  if (!document.fullscreenElement) await stage.requestFullscreen?.();
  else await document.exitFullscreen?.();
}, "btnFS"));

// --- recording (guards) ---
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

btnRec.addEventListener("click", () => safe(async () => {
  if (items.length === 0 || !audioEl.src){
    alert("画像と音源を入れてから書き出しして。");
    return;
  }
  clearDownloads();

  if (typeof cv.captureStream !== "function"){
    alert("この環境は canvas.captureStream 未対応。Chrome推奨。");
    logLine("❌ captureStream unsupported");
    return;
  }
  if (!window.MediaRecorder){
    alert("この環境は MediaRecorder 未対応。Chrome推奨。");
    logLine("❌ MediaRecorder unsupported");
    return;
  }

  await ensureAudioAnalysis();
  if (audioCtx.state === "suspended") await audioCtx.resume();

  rebuildAndSync();

  // ensure draw running
  if (!playing){
    playing = true;
    paused = false;
    lastTs = 0;
    raf = requestAnimationFrame(draw);
  }

  audioEl.currentTime = 0;
  try{ await audioEl.play(); }
  catch(e){
    logLine(`❌ 録画前の再生失敗: ${e?.message || e}`);
    alert("音源の再生に失敗。ログ見て。");
    setStatus("REC ERROR");
    return;
  }

  setStatus("RECORDING");

  const canvasStream = cv.captureStream(60);

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
    alert("録画の作成に失敗。ログ見て。");
    setStatus("REC ERROR");
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
    setStatus("REC DONE");
    logLine("✅ 録画完了（WebM生成）");
  }, "recorder.onstop");

  recorder.start(250);
  logLine(`✅ 録画開始 mime=${recorder.mimeType || "(default)"}`);

audioEl.onended = () => {
  if (recorder && recorder.state === "recording"){
    try{ recorder.requestData(); }catch{}
    recorder.stop();
  }
  stopAll();
};
}, "btnRec"));

btnRecStop.addEventListener("click", () => safe(() => {
  if (recorder && recorder.state === "recording") recorder.stop();
}, "btnRecStop"));

audioEl.addEventListener("ended", () => safe(() => { if (playing) stopAll(); }, "audio ended"));

// init
setStatus("READY");
renderList();
rebuildAndSync();
logLine("✅ 起動完了（安全版）");
