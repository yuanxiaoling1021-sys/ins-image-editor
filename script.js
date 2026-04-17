const canvas = document.getElementById("editorCanvas");
const ctx = canvas.getContext("2d");

const uploadInput = document.getElementById("uploadInput");
const nextBtn = document.getElementById("nextBtn");
const maskSection = document.getElementById("maskSection");
const statsSection = document.getElementById("statsSection");
const downloadBtn = document.getElementById("downloadBtn");
const statsHint = document.getElementById("statsHint");
const totalUsersEl = document.getElementById("totalUsers");
const totalGeneratedEl = document.getElementById("totalGenerated");
const totalSavedEl = document.getElementById("totalSaved");
const recommendRateEl = document.getElementById("recommendRate");
const recommendBtn = document.getElementById("recommendBtn");
const notRecommendBtn = document.getElementById("notRecommendBtn");

const scaleRange = document.getElementById("scaleRange");
const offsetXRange = document.getElementById("offsetXRange");
const offsetYRange = document.getElementById("offsetYRange");
const shapeSizeRange = document.getElementById("shapeSizeRange");
const densityRange = document.getElementById("densityRange");
const maskColorInput = document.getElementById("maskColor");
const colorPreview = document.getElementById("colorPreview");

const scaleValue = document.getElementById("scaleValue");
const offsetXValue = document.getElementById("offsetXValue");
const offsetYValue = document.getElementById("offsetYValue");
const shapeSizeValue = document.getElementById("shapeSizeValue");
const densityValue = document.getElementById("densityValue");

const shapeButtons = [...document.querySelectorAll(".shape-btn")];
const overlayCanvas = document.createElement("canvas");
const overlayCtx = overlayCanvas.getContext("2d");
let rafPending = false;

const state = {
  images: [],
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  shape: "star",
  maskColor: "#ff5a7a",
  shapeSize: 40,
  density: 90,
  step2Enabled: false,
  patternTop: [],
  patternBottom: [],
  surveyChoice: null,
  hasGeneratedInThisSession: false,
};

const appConfig = window.APP_CONFIG || {};
const telemetryEnabled = Boolean(appConfig.supabaseUrl && appConfig.supabaseAnonKey);
const visitorIdKey = "ins_editor_visitor_id";
let visitorId = localStorage.getItem(visitorIdKey);
if (!visitorId) {
  visitorId = crypto.randomUUID();
  localStorage.setItem(visitorIdKey, visitorId);
}

const ownerModeKey = "ins_editor_owner_mode";
const ownerCode = "Lynnxy";

function syncOwnerModeFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const ownerParam = params.get("owner");
  if (ownerParam === ownerCode) {
    localStorage.setItem(ownerModeKey, "1");
  }
  if (ownerParam === "off") {
    localStorage.removeItem(ownerModeKey);
  }
}

function isOwnerMode() {
  return localStorage.getItem(ownerModeKey) === "1";
}

function applyStatsVisibility() {
  statsSection.classList.toggle("hidden", !isOwnerMode());
}

function refreshStatsIfVisible() {
  if (!isOwnerMode()) return;
  refreshStats();
}

function scheduleRender() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    renderCanvas();
  });
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getSupabaseHeaders(prefer) {
  const headers = {
    apikey: appConfig.supabaseAnonKey,
    Authorization: `Bearer ${appConfig.supabaseAnonKey}`,
    "Content-Type": "application/json",
  };
  if (prefer) headers.Prefer = prefer;
  return headers;
}

function extractSupabaseErrorMessage(rawText) {
  if (!rawText) return "";
  try {
    const parsed = JSON.parse(rawText);
    return parsed.message || parsed.error_description || parsed.error || rawText;
  } catch {
    return rawText;
  }
}

function classifyStatsError(message) {
  const text = (message || "").toLowerCase();
  if (text.includes("permission denied") || text.includes("not allowed") || text.includes("jwt")) {
    return "统计读取失败：请确认 Supabase 表开启了 SELECT 权限（RLS policy）。";
  }
  if (text.includes("does not exist") || text.includes("relation") || text.includes("column")) {
    return "统计读取失败：请检查 Supabase 表结构与字段名称是否正确。";
  }
  if (text.includes("content security policy") || text.includes("unsafe-eval") || text.includes("eval")) {
    return "统计读取失败：当前站点 CSP 禁止某些脚本行为，请在同源环境直接打开此页面后重试。";
  }
  return "统计读取失败，请检查 Supabase 表结构与权限。";
}

async function supabaseInsert(table, payload, prefer) {
  const url = `${appConfig.supabaseUrl}/rest/v1/${table}`;
  const res = await fetch(url, {
    method: "POST",
    headers: getSupabaseHeaders(prefer),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const detail = extractSupabaseErrorMessage(await res.text());
    throw new Error(`Insert ${table} failed: ${res.status} ${detail}`);
  }
}

async function getTableCount(table, filter = "") {
  const params = new URLSearchParams();
  params.set("select", "id");
  if (filter) {
    const [key, value] = filter.split("=");
    if (key && value) params.set(key, value);
  }
  const url = `${appConfig.supabaseUrl}/rest/v1/${table}?${params.toString()}`;
  const res = await fetch(url, {
    method: "HEAD",
    headers: getSupabaseHeaders("count=exact"),
  });
  if (!res.ok) {
    const detail = extractSupabaseErrorMessage(await res.text());
    throw new Error(`Count ${table} failed: ${res.status} ${detail}`);
  }
  const range = res.headers.get("content-range");
  if (!range) return 0;
  const total = Number(range.split("/")[1]);
  return Number.isNaN(total) ? 0 : total;
}

function setStatsUnavailable(message) {
  statsHint.textContent = message;
  totalUsersEl.textContent = "-";
  totalGeneratedEl.textContent = "-";
  totalSavedEl.textContent = "-";
  recommendRateEl.textContent = "-";
}

async function refreshStats() {
  if (!telemetryEnabled) {
    setStatsUnavailable("统计未配置：请在 index.html 的 APP_CONFIG 中填写 Supabase 信息。");
    return;
  }

  try {
    const countTasks = [
      getTableCount("editor_users"),
      getTableCount("editor_events", "event_type=eq.generated"),
      getTableCount("editor_events", "event_type=eq.saved"),
      getTableCount("editor_feedback", "recommend=eq.true"),
      getTableCount("editor_feedback"),
    ];
    const results = await Promise.allSettled(countTasks);
    const firstError = results.find((item) => item.status === "rejected");
    if (firstError) {
      throw firstError.reason;
    }

    const [users, generated, saved, recommended, feedbackTotal] = results.map((item) => item.value);
    totalUsersEl.textContent = String(users);
    totalGeneratedEl.textContent = String(generated);
    totalSavedEl.textContent = String(saved);
    recommendRateEl.textContent = feedbackTotal ? `${Math.round((recommended / feedbackTotal) * 100)}%` : "0%";
    statsHint.textContent = "统计数据已实时更新";
  } catch (error) {
    console.error(error);
    setStatsUnavailable(classifyStatsError(error.message));
  }
}

async function trackEvent(eventType, payload = {}) {
  if (!telemetryEnabled) return;
  try {
    await supabaseInsert("editor_events", [
      {
        visitor_id: visitorId,
        event_type: eventType,
        payload,
      },
    ]);
  } catch (error) {
    console.error(error);
  }
}

async function ensureUserTracked() {
  if (!telemetryEnabled) return;
  try {
    await supabaseInsert(
      "editor_users",
      [{ visitor_id: visitorId, last_seen_at: new Date().toISOString() }],
      "resolution=merge-duplicates"
    );
    await trackEvent("visit", { ua: navigator.userAgent });
  } catch (error) {
    console.error(error);
  }
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function drawCoverImage(img, dx, dy, dw, dh) {
  const scale = Math.max(dw / img.width, dh / img.height) * state.scale;
  const sw = dw / scale;
  const sh = dh / scale;
  const sx = clamp((img.width - sw) / 2 - state.offsetX / scale, 0, img.width - sw);
  const sy = clamp((img.height - sh) / 2 - state.offsetY / scale, 0, img.height - sh);
  ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
}

function drawStar(x, y, radius, targetCtx = ctx) {
  const inner = radius * 0.45;
  targetCtx.beginPath();
  for (let i = 0; i < 10; i += 1) {
    const angle = (Math.PI / 5) * i - Math.PI / 2;
    const r = i % 2 === 0 ? radius : inner;
    const px = x + Math.cos(angle) * r;
    const py = y + Math.sin(angle) * r;
    if (i === 0) {
      targetCtx.moveTo(px, py);
    } else {
      targetCtx.lineTo(px, py);
    }
  }
  targetCtx.closePath();
  targetCtx.fill();
}

function drawCircle(x, y, radius, targetCtx = ctx) {
  targetCtx.beginPath();
  targetCtx.arc(x, y, radius, 0, Math.PI * 2);
  targetCtx.fill();
}

function drawShape(shape, x, y, radius, targetCtx = ctx) {
  if (shape === "star") drawStar(x, y, radius, targetCtx);
  if (shape === "circle") drawCircle(x, y, radius, targetCtx);
}

function randomIn(min, max) {
  return Math.random() * (max - min) + min;
}

function buildPatternGroup(yMin, yMax, count, sizeMin, sizeMax, shape) {
  const list = [];
  const maxAttempts = count * 50;
  let attempts = 0;

  while (list.length < count && attempts < maxAttempts) {
    attempts += 1;
    const size = randomIn(sizeMin, sizeMax);
    const radius = size * 0.5;
    const candidate = {
      x: randomIn(radius, canvas.width - radius),
      y: randomIn(yMin + radius, yMax - radius),
      size,
      shape,
    };

    const overlap = list.some((item) => {
      const dx = item.x - candidate.x;
      const dy = item.y - candidate.y;
      const minDistance = item.size * 0.5 + radius + 8;
      return dx * dx + dy * dy < minDistance * minDistance;
    });

    if (!overlap) {
      list.push(candidate);
    }
  }
  return list;
}

function regeneratePatterns() {
  // 同一疏密滑杆 -> 上下使用同一数量与尺寸模型，保证视觉密度一致
  const densityFactor = (170 - state.density) / 150;
  const countPerHalf = Math.round(14 + densityFactor * 34);
  const base = state.shapeSize;
  const sizeMin = base * 0.5;
  const sizeMax = base * 1.35;

  state.patternTop = buildPatternGroup(0, canvas.height * 0.5, countPerHalf, sizeMin, sizeMax, state.shape);
  state.patternBottom = buildPatternGroup(
    canvas.height * 0.5,
    canvas.height,
    countPerHalf,
    sizeMin,
    sizeMax,
    state.shape
  );
}

function drawPatternOverlay() {
  if (!state.step2Enabled) return;
  if (overlayCanvas.width !== canvas.width) overlayCanvas.width = canvas.width;
  if (overlayCanvas.height !== canvas.height) overlayCanvas.height = canvas.height;
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

  // 上半区：图案实心，其他留空
  overlayCtx.fillStyle = state.maskColor;
  for (const item of state.patternTop) {
    drawShape(item.shape, item.x, item.y, item.size * 0.5, overlayCtx);
  }

  // 下半区：先整块实心，再挖空图案 -> 叠回主图后空心区域透出原照片
  overlayCtx.fillStyle = state.maskColor;
  overlayCtx.fillRect(0, canvas.height * 0.5, canvas.width, canvas.height * 0.5);
  overlayCtx.globalCompositeOperation = "destination-out";
  for (const item of state.patternBottom) {
    drawShape(item.shape, item.x, item.y, item.size * 0.5, overlayCtx);
  }
  overlayCtx.globalCompositeOperation = "source-over";

  ctx.drawImage(overlayCanvas, 0, 0);
}

function renderCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (state.images.length === 0) {
    ctx.fillStyle = "#bcc2d8";
    ctx.font = "36px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("请先上传图片", canvas.width / 2, canvas.height / 2);
    return;
  }

  if (state.images.length === 1) {
    drawCoverImage(state.images[0], 0, 0, canvas.width, canvas.height);
  } else {
    const h = canvas.height / 2;
    drawCoverImage(state.images[0], 0, 0, canvas.width, h);
    drawCoverImage(state.images[1], 0, h, canvas.width, h);
  }

  drawPatternOverlay();
}

async function handleUploadChange(e) {
  const files = [...e.target.files].slice(0, 2);
  if (!files.length) return;

  try {
    state.images = await Promise.all(files.map((f) => loadImage(f)));
    scheduleRender();
  } catch (error) {
    console.error(error);
    alert("图片读取失败，请重试。");
  }
}

function bindSlider(slider, view, formatter, onChange) {
  const run = () => {
    const value = Number(slider.value);
    view.textContent = formatter(value);
    onChange(value);
    scheduleRender();
  };
  slider.addEventListener("input", run);
  run();
}

function syncOffsetControls() {
  offsetXRange.value = String(Math.round(state.offsetX));
  offsetYRange.value = String(Math.round(state.offsetY));
  offsetXValue.textContent = `${Math.round(state.offsetX)}`;
  offsetYValue.textContent = `${Math.round(state.offsetY)}`;
}

function syncScaleControl() {
  const percent = Math.round(state.scale * 100);
  scaleRange.value = String(percent);
  scaleValue.textContent = `${percent}%`;
}

function bindCanvasTouchGestures() {
  let pinchStartDistance = 0;
  let pinchStartScale = 1;

  canvas.addEventListener(
    "touchstart",
    (e) => {
      if (!state.images.length) return;
      if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        pinchStartDistance = Math.hypot(dx, dy);
        pinchStartScale = state.scale;
        e.preventDefault();
      }
    },
    { passive: false }
  );

  canvas.addEventListener(
    "touchmove",
    (e) => {
      if (!state.images.length) return;
      if (e.touches.length === 2 && pinchStartDistance > 0) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const currentDistance = Math.hypot(dx, dy);
        const ratio = currentDistance / pinchStartDistance;
        state.scale = clamp(pinchStartScale * ratio, 0.5, 2);
        syncScaleControl();
        scheduleRender();
        e.preventDefault();
      }
    },
    { passive: false }
  );

  canvas.addEventListener("touchend", () => {
    pinchStartDistance = 0;
  });
}

uploadInput.addEventListener("change", handleUploadChange);

nextBtn.addEventListener("click", () => {
  if (!state.images.length) {
    alert("请先上传至少一张图片。");
    return;
  }
  state.step2Enabled = true;
  if (!state.hasGeneratedInThisSession) {
    state.hasGeneratedInThisSession = true;
    trackEvent("generated", { imageCount: state.images.length });
    refreshStatsIfVisible();
  }
  regeneratePatterns();
  maskSection.classList.remove("hidden");
  scheduleRender();
  maskSection.scrollIntoView({ behavior: "auto", block: "start" });
});

maskColorInput.addEventListener("input", () => {
  state.maskColor = maskColorInput.value;
  colorPreview.style.background = state.maskColor;
  scheduleRender();
});

shapeButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    state.shape = btn.dataset.shape;
    shapeButtons.forEach((item) => item.classList.remove("active"));
    btn.classList.add("active");
    regeneratePatterns();
    scheduleRender();
  });
});

downloadBtn.addEventListener("click", () => {
  const a = document.createElement("a");
  a.download = `ins-editor-${Date.now()}.png`;
  a.href = canvas.toDataURL("image/png");
  a.click();
  trackEvent("saved", { imageCount: state.images.length });
  refreshStatsIfVisible();
});

function setSurveyChoice(choice) {
  state.surveyChoice = choice;
  recommendBtn.classList.toggle("active", choice === "recommend");
  notRecommendBtn.classList.toggle("active", choice === "not_recommend");
}

async function submitSurvey(choice) {
  setSurveyChoice(choice);
  if (!telemetryEnabled) {
    alert("反馈模块未配置云端统计，请先填写 APP_CONFIG。");
    return;
  }
  try {
    await supabaseInsert("editor_feedback", [
      {
        visitor_id: visitorId,
        recommend: choice === "recommend",
        comment: "",
      },
    ]);
    alert("感谢反馈，已收到！");
    setSurveyChoice(null);
    refreshStatsIfVisible();
  } catch (error) {
    console.error(error);
    alert("提交失败，请稍后再试。");
  }
}

recommendBtn.addEventListener("click", () => submitSurvey("recommend"));
notRecommendBtn.addEventListener("click", () => submitSurvey("not_recommend"));

bindSlider(scaleRange, scaleValue, (v) => `${v}%`, (v) => {
  state.scale = v / 100;
});

bindSlider(offsetXRange, offsetXValue, (v) => `${v}`, (v) => {
  state.offsetX = v;
});

bindSlider(offsetYRange, offsetYValue, (v) => `${v}`, (v) => {
  state.offsetY = v;
});

bindSlider(shapeSizeRange, shapeSizeValue, (v) => `${v}`, (v) => {
  state.shapeSize = v;
  if (state.step2Enabled) regeneratePatterns();
});

bindSlider(densityRange, densityValue, (v) => `${v}`, (v) => {
  state.density = v;
  if (state.step2Enabled) regeneratePatterns();
});

colorPreview.style.background = state.maskColor;
bindCanvasTouchGestures();
scheduleRender();
syncOwnerModeFromUrl();
applyStatsVisibility();
ensureUserTracked().then(refreshStatsIfVisible);
