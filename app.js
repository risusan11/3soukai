// 三送会：画像順番 + 音源同期 + 右下シュール球体 + 飽き対策 + WebM書き出し
// 依存なし（素のHTML/CSS/JSで動く）

const $ = (id) => document.getElementById(id);

const imgInput = $("imgInput");
const audInput = $("audInput");
const imgList  = $("imgList");

const audioEl  = $("audio");
const audLenEl = $("audLen");
const loopsEl  = $("loops");

const btnPlay  = $("btnPlay");
const btnPause = $("btnPause");
const btnStop  = $("btnStop");
const btnFS    = $("btnFS");

const btnRec   = $("btnRec");
const btnRecStop = $("btnRecStop");
const dlLink   = $("dlLink");

const stage    = $("stage");
const cv       = $("cv");
const ctx      = cv.getContext("2d", { alpha:false });

const statusPill = $("statusPill");
const badge = $("badge");
const bar = $("bar");
const speedBadge = $("speedBadge");

const flowStrengthEl = $("flowStrength");
const spiceEl = $("spice");
const fitModeEl = $("fitMode");
const orbOnEl = $("orbOn");

let items = []; // {id, name, url, img}
let playing = false;
let paused = false;

let raf = 0;
let lastTs = 0;

let audioCtx = null;
let analyser = null;
let audioSrcNode = null;
let freqData = null;

// marquee state
let track = [];     // expanded items for visuals
let spacingBase = 34;
let cycleWidth = 0;
let offsetX = 0;

// sync state
let basePps = 80;        // computed from audio duration and cycleWidth
let loops = 1;
let T = 0;               // audio duration (seconds)

// recorder
let recorder = null;
let recChunks = [];

// ---------- helpers ----------
const clamp = (v,a,b) => Math.max(a, Math.min(b,v));
const fmtTime = (s) => {
  if (!Number.isFinite(s)) return "-";
  const m = Math.floor(s/60);
  const ss = Math.floor(s%60).toString().padStart(2,"0");
  return `${m}:${ss}`;
};

function setStatus(text){ statusPill.textContent = text; }

// Resize canvas to actual pixels
function resizeCanvas(){
  const r = stage.getBoundingClientRect();
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  cv.width = Math.floor(r.width * dpr);
  cv.height = Math.floor(r.height * dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0); // draw in CSS pixels
}
new ResizeObserver(resizeCanvas).observe(stage);
window.addEventListener("resize", resizeCanvas);
resizeCanvas();

function revokeUrl(url){ try{ URL.revokeObjectURL(url); } catch {} }

function clearDownloads(){
  dlLink.style.display = "none";
  dlLink.href = "#";
}

// ---------- list UI ----------
function renderList(){
  imgList.innerHTML = "";
  if (items.length === 0){
    const empty = document.createElement("div");
    empty.className = "hint";
    empty.textContent = "画像がまだない。まず画像→次に音源→再生/書き出し。";
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
      btn.addEventListener("click", () => {
        const act = btn.dataset.act;
        if (act === "del"){
          revokeUrl(it.url);
          items.splice(idx, 1);
          renderList();
          rebuildTrackAndSync();
          return;
        }
        if (act === "up" && idx > 0){
          [items[idx-1], items[idx]] = [items[idx], items[idx-1]];
          renderList();
          rebuildTrackAndSync();
          return;
        }
        if (act === "down" && idx < items.length - 1){
          [items[idx+1], items[idx]] = [items[idx], items[idx+1]];
          renderList();
          rebuildTrackAndSync();
          return;
        }
      });
    });

    // drag reorder
    row.addEventListener("dragstart", (e) => {
      row.classList.add("dragging");
      e.dataTransfer.setData("text/plain", row.dataset.index);
      e.dataTransfer.effectAllowed = "move";
    });
    row.addEventListener("dragend", () => row.classList.remove("dragging"));
    row.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect="move"; });
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      const from = Number(e.dataTransfer.getData("text/plain"));
      const to = Number(row.dataset.index);
      if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return;
      const moved = items.splice(from, 1)[0];
      items.splice(to, 0, moved);
      renderList();
      rebuildTrackAndSync();
    });

    imgList.appendChild(row);
  });
}

// ---------- load images ----------
imgInput.addEventListener("change", async () => {
  clearDownloads();
  const files = Array.from(imgInput.files || []);
  if (files.length === 0) return;

  for (const f of files){
    const url = URL.createObjectURL(f);
    const img = await loadImage(url);
    items.push({ id: crypto.randomUUID(), name: f.name, url, img });
  }
  imgInput.value = "";
  renderList();
  rebuildTrackAndSync();
});

function loadImage(url){
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

// ---------- audio ----------
audInput.addEventListener("change", () => {
  clearDownloads();
  const f = (audInput.files || [])[0];
  if (!f) return;

  const url = URL.createObjectURL(f);
  audioEl.src = url;
  audioEl.load();

  // duration available after metadata
  audioEl.onloadedmetadata = () => {
    T = audioEl.duration || 0;
    audLenEl.textContent = `${fmtTime(T)}（${T.toFixed(2)}s）`;
    rebuildTrackAndSync();
  };
});

// ---------- sync calc ----------
function pickLoopsAuto(durationSec){
  // 長い曲ほど同じ列を何周もさせた方が“止まってる感”が消える
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 1;
  if (durationSec < 70) return 1;
  if (durationSec < 140) return 2;
  if (durationSec < 210) return 3;
  return 4;
}

loopsEl.addEventListener("change", () => rebuildTrackAndSync());
fitModeEl.addEventListener("change", () => rebuildTrackAndSync());

function rebuildTrackAndSync(){
  // Build expanded track to avoid gaps
  track = [];
  cycleWidth = 0;
  offsetX = 0;

  if (items.length === 0){
    setStatus("READY");
    return;
  }

  // expand to at least ~16 visible images worth to keep continuity
  const minCount = 16;
  while (track.length < minCount){
    for (const it of items) track.push(it);
    if (track.length > 120) break;
  }

  // Measure cycle width by estimating draw widths (needs canvas size)
  // We'll compute after first render pass as well, but do a first estimate:
  cycleWidth = estimateCycleWidth();

  // loops
  const chosen = loopsEl.value === "auto" ? String(pickLoopsAuto(T)) : loopsEl.value;
  loops = Number(chosen) || 1;

  // base speed based on audio duration
  if (T > 0 && cycleWidth > 0){
    const a = Math.min(60, T);
    const b = Math.max(0, T - 60);
    const effective = 0.9 * a + 1.0 * b; // integral of multiplier
    basePps = (cycleWidth * loops) / Math.max(0.001, effective); // px/sec
    setStatus("SYNCED");
  } else {
    // fallback when no audio yet
    basePps = 60;
    setStatus("IMAGES OK");
  }
}

function estimateCycleWidth(){
  // approximate: draw each image height = 78% of stage height in CSS px
  const r = stage.getBoundingClientRect();
  const H = r.height;
  const imgH = H * 0.78;
  const gap = spacingBase;

  let w = 0;
  for (const it of track){
    const iw = it.img?.width || 1000;
    const ih = it.img?.height || 1000;
    // width depends on contain/cover
    const fit = fitModeEl.value;
    let drawW;
    if (fit === "contain"){
      drawW = imgH * (iw/ih);
    } else {
      // cover: we pretend a 16:9-ish block effect (slightly wider)
      drawW = imgH * (iw/ih);
      drawW *= 1.08;
    }
    w += drawW + gap;
  }
  // one "cycle" is one set (track) width
  return w;
}

// ---------- audio analysis (for “飽きない” & orb reaction) ----------
async function ensureAudioAnalysis(){
  if (audioCtx) return;

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.85;
  freqData = new Uint8Array(analyser.frequencyBinCount);

  // route: <audio> element -> analyser -> destination
  audioSrcNode = audioCtx.createMediaElementSource(audioEl);
  audioSrcNode.connect(analyser);
  analyser.connect(audioCtx.destination);
}

function getEnergy(){
  if (!analyser || !freqData) return 0;
  analyser.getByteFrequencyData(freqData);

  // low-mid energy (beat-ish)
  const n = freqData.length;
  const start = Math.floor(n * 0.02);
  const end = Math.floor(n * 0.18);
  let sum = 0;
  for (let i=start;i<end;i++) sum += freqData[i];
  const avg = sum / Math.max(1, (end-start));
  return avg / 255; // 0..1
}

// ---------- render ----------
function currentMultiplier(t){
  return (t < 60) ? 0.9 : 1.0;
}

let orb = {
  phase: 0,
  spin: 0,
  pop: 0,
  popCooldown: 0
};

function draw(ts){
  if (!playing){ return; }
  if (!lastTs) lastTs = ts;

  const dt = (ts - lastTs) / 1000;
  lastTs = ts;

  if (!paused){
    // time from audio is the truth (sync)
    // if audio not playing, we still animate using dt
    const t = (!audioEl.paused && Number.isFinite(audioEl.currentTime)) ? audioEl.currentTime : (badge._t || 0) + dt;
    badge._t = t;

    const mul = currentMultiplier(t);

    // flow strength slider
    const flowMul = Number(flowStrengthEl.value) || 1.0;

    // speed computed from audio + cycleWidth
    const pps = basePps * mul * flowMul;

    offsetX -= pps * dt;
    if (cycleWidth > 0){
      while (offsetX <= -cycleWidth) offsetX += cycleWidth;
    }

    // HUD
    badge.textContent = `${t.toFixed(1)}s`;
    speedBadge.textContent = `x${mul.toFixed(2)}`;
    if (T > 0){
      const prog = clamp(t / T, 0, 1);
      bar.style.width = `${(prog*100).toFixed(2)}%`;
    } else {
      bar.style.width = "0%";
    }

    // audio energy for “飽きない”
    const spice = Number(spiceEl.value) || 0;
    const energy = (audioCtx && !audioEl.paused) ? getEnergy() : 0;

    // micro variations
    const micro = 1 + spice * 0.025 * Math.sin(t * 0.55) + spice * 0.015 * Math.sin(t * 1.1 + 1.2);
    const gapJitter = spice * (8 * (0.5 - Math.abs(((t*0.15)%1)-0.5)*2)); // slow pulse 0..spice*8

    // background: subtle exposure pulse (schur)
    const flash = spice * 0.06 * (energy ** 1.6);
    ctx.fillStyle = `rgb(${Math.floor(8+flash*30)},${Math.floor(8+flash*18)},${Math.floor(12+flash*36)})`;
    ctx.fillRect(0,0,cv.width,cv.height);

    // draw images row
    spacingBase = 34 + gapJitter;
    drawMarquee(t, micro);

    // orb bottom-right
    if (orbOnEl.value === "on"){
      drawOrb(t, dt, energy, spice);
    }

    // vignette
    drawVignette();
  }

  raf = requestAnimationFrame(draw);
}

function drawMarquee(t, micro){
  const r = stage.getBoundingClientRect();
  const W = r.width;
  const H = r.height;

  const imgH = H * 0.78;
  const y = (H - imgH) / 2;

  // re-measure cycle width occasionally (resize / fit changes)
  if (Math.random() < 0.015){
    cycleWidth = estimateCycleWidth();
  }

  let x = offsetX;

  // draw enough images to cover screen + spare
  const fit = fitModeEl.value;

  // “飽きない”：たまにほんの少しだけ上下揺れ（見えないくらい）
  const drift = (Number(spiceEl.value)||0) * 1.6 * Math.sin(t * 0.35);

  for (let i=0; i<track.length; i++){
    const it = track[i];
    const img = it.img;
    if (!img) continue;

    const iw = img.width, ih = img.height;
    let drawW = imgH * (iw/ih);
    if (fit === "cover"){
      drawW *= 1.08;
    }

    // if x is far left, skip until near
    if (x > W + 200){
      // do nothing
    } else if (x + drawW >= -200){
      // subtle per-image micro motion (no border)
      const local = 0.007 * Math.sin(t*0.6 + i*0.8) * (Number(spiceEl.value)||0);
      const z = 1.0 + local;

      ctx.save();
      ctx.translate(x + drawW/2, y + imgH/2 + drift);
      ctx.scale(z * micro, z * micro);

      if (fit === "contain"){
        ctx.drawImage(img, -drawW/2, -imgH/2, drawW, imgH);
      } else {
        // cover-like: crop slightly center
        // keep it simple: draw a bit larger and let it crop by canvas (still no border)
        ctx.drawImage(img, -drawW/2, -imgH/2, drawW, imgH);
      }

      ctx.restore();
    }

    x += drawW + spacingBase;

    // if we've passed beyond screen and have enough, break
    if (x > W + 400) break;
  }
}

function drawOrb(t, dt, energy, spice){
  const r = stage.getBoundingClientRect();
  const W = r.width;
  const H = r.height;

  const size = Math.min(140, W * 0.16);
  const pad = 18;
  const cx = W - pad - size/2;
  const cy = H - pad - size/2;

  // orb dynamics: slow breathing + occasional spin impulse from energy peaks
  orb.phase += dt * (0.9 + spice*0.2);
  orb.spin += dt * 0.2;

  // detect “peak-ish” and trigger pop with cooldown
  if (orb.popCooldown > 0) orb.popCooldown -= dt;
  const peak = (energy > 0.55 + (1 - spice) * 0.1) && orb.popCooldown <= 0 && spice > 0.05;
  if (peak){
    orb.pop = 1.0;
    orb.popCooldown = 0.6; // don't spam
    orb.spin += 0.8;
  } else {
    orb.pop = Math.max(0, orb.pop - dt * 2.4);
  }

  const breathe = 1 + 0.03 * Math.sin(orb.phase) + 0.015 * Math.sin(orb.phase*0.7 + 2.0);
  const popScale = 1 + orb.pop * 0.08;
  const rot = 0.25 * Math.sin(orb.spin) + orb.pop * 0.2;

  // shaded sphere
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  ctx.scale(breathe * popScale, (breathe*0.98) * popScale);

  // shadow
  ctx.globalAlpha = 0.28;
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.ellipse(0, size*0.42, size*0.36, size*0.10, 0, 0, Math.PI*2);
  ctx.fill();

  // sphere gradient
  const g = ctx.createRadialGradient(-size*0.18, -size*0.18, size*0.12, 0, 0, size*0.62);
  g.addColorStop(0, "rgba(255,255,255,0.80)");
  g.addColorStop(0.35, "rgba(170,180,210,0.55)");
  g.addColorStop(1, "rgba(35,38,58,0.92)");

  ctx.globalAlpha = 0.95;
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0,0,size*0.40,0,Math.PI*2);
  ctx.fill();

  // spec highlight
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

// ---------- playback controls ----------
btnPlay.addEventListener("click", async () => {
  if (items.length === 0){
    alert("先に画像を追加して、順番を決めて。");
    return;
  }
  if (!audioEl.src){
    alert("次に音源をアップロードして。");
    return;
  }

  await ensureAudioAnalysis();
  if (audioCtx.state === "suspended") await audioCtx.resume();

  rebuildTrackAndSync();

  if (!playing){
    playing = true;
    paused = false;
    lastTs = 0;
    setStatus("PLAYING");
    // start audio from 0 for consistent sync
    audioEl.currentTime = 0;
    await audioEl.play();
    raf = requestAnimationFrame(draw);
  } else if (paused){
    paused = false;
    setStatus("PLAYING");
    await audioEl.play();
  }
});

btnPause.addEventListener("click", async () => {
  if (!playing) return;
  paused = !paused;
  setStatus(paused ? "PAUSED" : "PLAYING");
  if (paused) audioEl.pause();
  else {
    await ensureAudioAnalysis();
    if (audioCtx.state === "suspended") await audioCtx.resume();
    await audioEl.play();
  }
});

btnStop.addEventListener("click", () => {
  stopAll();
});

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
  // clear frame
  ctx.fillStyle = "#000";
  ctx.fillRect(0,0,cv.width,cv.height);
}

// Fullscreen
btnFS.addEventListener("click", async () => {
  if (!document.fullscreenElement){
    await stage.requestFullscreen?.();
  } else {
    await document.exitFullscreen?.();
  }
});

// ---------- recording (Canvas + Audio) ----------
btnRec.addEventListener("click", async () => {
  if (items.length === 0 || !audioEl.src){
    alert("画像と音源を入れてから書き出しして。");
    return;
  }
  clearDownloads();
  await ensureAudioAnalysis();
  if (audioCtx.state === "suspended") await audioCtx.resume();

  rebuildTrackAndSync();

  // Ensure playing from start
  if (!playing){
    playing = true;
    paused = false;
    lastTs = 0;
    setStatus("RECORDING");
    audioEl.currentTime = 0;
    await audioEl.play();
    raf = requestAnimationFrame(draw);
  } else {
    // restart to align
    audioEl.currentTime = 0;
    await audioEl.play();
    setStatus("RECORDING");
  }

  // capture canvas at 60fps
  const canvasStream = cv.captureStream(60);

  // capture audio element via AudioContext destination:
  // easiest stable approach: create a MediaStreamDestination and connect analyser to it too
  const dest = audioCtx.createMediaStreamDestination();
  // route analyser output to destination (analyser already connected to destination speakers)
  // connect source to dest as well
  audioSrcNode.disconnect();
  audioSrcNode.connect(analyser);
  audioSrcNode.connect(dest);
  analyser.connect(audioCtx.destination);

  const audioStream = dest.stream;

  // combine
  const tracks = [
    ...canvasStream.getVideoTracks(),
    ...audioStream.getAudioTracks()
  ];
  const mixed = new MediaStream(tracks);

  recorder = new MediaRecorder(mixed, {
    mimeType: "video/webm;codecs=vp9,opus"
  });

  recChunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) recChunks.push(e.data);
  };
  recorder.onstop = () => {
    const blob = new Blob(recChunks, { type: recorder.mimeType || "video/webm" });
    const url = URL.createObjectURL(blob);
    dlLink.href = url;
    dlLink.style.display = "inline-flex";
    dlLink.textContent = "ダウンロード（WebM）";
    setStatus("REC DONE");
  };

  recorder.start(250); // chunk every 250ms

  // auto-stop when audio ends
  audioEl.onended = () => {
    if (recorder && recorder.state === "recording") recorder.stop();
    stopAll();
  };
});

btnRecStop.addEventListener("click", () => {
  if (recorder && recorder.state === "recording"){
    recorder.stop();
  }
});

// ---------- misc ----------
audioEl.addEventListener("ended", () => {
  if (playing) stopAll();
});

setStatus("READY");
renderList();