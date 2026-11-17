/**
 * Solar System Particle Observatory — application shell.
 *
 * The app deliberately keeps three layers separate:
 *   ui.js        DOM, copy, focus panel, distance band, modals
 *   scene.js     renderer, camera choreography, picking
 *   main.js      application state, time, gestures, input, URL and debug bridge
 */

import * as THREE from 'three';
import { CONFIG, resolveRuntime } from './config.js';
import { PLANETS, PLANET_BY_ID, SUN } from './data.js';
import { COMET } from './comet.js';
import { MOON } from './moon.js';
import { formatDate } from './astro.js';
import { createUI } from './ui.js';
import { createSceneStage } from './scene.js';
import { HandController } from './handControls.js';
import { HandOverlay, computeCoverLayout } from './handOverlay.js';
import { HandTracker, describeCameraError } from '../../src/handTracker.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const nowSeconds = () => performance.now() / 1000;

const runtime = resolveRuntime();
const root = document.getElementById('app');const canvas = document.getElementById('webgl-canvas');
const video = document.getElementById('camera-video');
const overlayCanvas = document.getElementById('hand-overlay');
const startButton = document.getElementById('start-btn');
const earthLayerButton = document.getElementById('earth-layer-btn');
const focusBackButton = document.getElementById('focus-back');
const focusPrevButton = document.getElementById('focus-prev');
const focusNextButton = document.getElementById('focus-next');
const BODY_BY_ID = Object.freeze({ sun: SUN, ...PLANET_BY_ID, halley: COMET, moon: MOON });
const FOCUS_ORDER = Object.freeze([SUN, ...PLANETS]);

const SPEEDS = CONFIG.time.speeds;
const SPEED_LABELS = CONFIG.time.speedLabels;
const INITIAL_PLANET_ID =
  runtime.startPlanet && BODY_BY_ID[runtime.startPlanet]
    ? runtime.startPlanet
    : CONFIG.ui.defaultPlanet;

const state = {
  phase: 'intro',
  booted: false,
  ready: false,
  cameraState: 'idle',
  cameraBusy: false,
  cameraSession: 0,
  autoDemo: runtime.startInDemo,
  scaleMode: runtime.scaleMode,
  speedIndex: runtime.reducedMotion ? CONFIG.ui.reducedMotionSpeedIndex : CONFIG.ui.defaultSpeedIndex,
  simMs: Date.now(),
  activePlanetId: INITIAL_PLANET_ID,
  orbit: true,
  handVisible: false,
  handState: null,
  handStates: [],
  secondHandSince: 0,
  twoHandAnchor: null,
  lastFrame: null,
  lastHandAt: 0,
  lastPointerAt: 0,
  pointer: { x: 0.5, y: 0.5, down: false, moved: 0, lastX: 0, lastY: 0 },
  manualLook: { x: 0, y: 0 },
  look: { x: 0, y: 0 },
  pinchHold: null,
  lastPinchUiAt: 0,
  pinchRotate: null,
  earthZoomBeforeLayers: 1,
  earthFingerCandidate: null,
  zoomAnchorPalm: null,
  handDistanceAnchor: null,
  lastPalmScale: 0,
  zoomLastMoveAt: 0,
  zoomStillFrames: 0,
  twoHandLastScale: 0,
  twoHandStillFrames: 0,
  twoHandLastMoveAt: 0,
  zoomAnchorZoom: 1,
  dragPointers: new Map(),
  touchDistance: 0,
  elapsed: 0,
  fps: 60,
  frames: 0,
  hudAccumulator: 0,
  labelAccumulator: 0,
  dateAccumulator: 0,
  lastZoomHud: 1,
  fistSamples: [],
  fistSwipeUntil: 0,
  fistSwipeCooldownUntil: 0,
  tutorialLook: { x: 0, y: 0 },
  tutorialLookUntil: 0,
};

let stage = null;
let ui = null;
let handController = null;
let handControllers = [];
let handOverlay = null;
let handTracker = null;
let labels = [];
let labelNodes = new Map();
let lastFrameTime = performance.now();
let resizeQueued = false;
let loadingMessage = '';
let startedCamera = false;

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

ui = createUI({
  root,
  planets: PLANETS,
  railBodies: [SUN, ...PLANETS],
  handlers: {
    onStart: () => {
      if (tutorialSeen()) startCamera();
      else openTutorial({ after: () => startCamera() });
    },
    onDemo: () => {
      if (tutorialSeen()) enterDemo({ announce: true });
      else openTutorial({ after: () => enterDemo({ announce: true }) });
    },
    onPlanetSelect: (id) => selectPlanet(id),
    onDistanceBody: (id) => handleDistanceBody(id),
    onPrevPlanet: () => switchFocus(-1),
    onNextPlanet: () => switchFocus(1),
    onFocusBack: () => handleFocusBack(),
    onSpeed: () => cycleSpeed(),
    onScale: () => toggleScale(),
    onShare: () => share(),
    onHelp: () => {},
    onHelpClose: () => {},
    onRetry: () => startCamera(),
    onErrorClose: () => closeError(),
    onToggleOrbit: (enabled) => toggleOrbit(enabled),
  },
});

// ---------------------------------------------------------------------------
// First-run gesture tutorial
// ---------------------------------------------------------------------------

const TUTORIAL_STEPS = [
  {
    title: '手掌远近 · 缩放',
    desc: '手掌靠近摄像头时视角拉近，远离时拉远；手停住后缩放会锁定；手掌左右移动只转动视角，握拳横挥只切换行星。',
    glyph: '✋',
    effect: 'MOVE CLOSER / FARTHER',
  },
  {
    title: '手掌移动 · 旋转视角',
    desc: '手掌向左，视角跟着向左；手掌向右，视角向右。上下移动改变俯仰，特写和总览都可以用。',
    glyph: '↔',
    effect: 'LOOK AROUND',
  },
  {
    title: '捏一下 · 选择天体',
    desc: '捏合相当于鼠标点击：可以点返回、地球层按钮，也可以选中行星或月球。用食指尖指向目标，拇指与食指轻轻捏一下即可。',
    glyph: '🤏',
    effect: 'PINCH TO SELECT',
  },
  {
    title: '握拳托住 · 握拳横挥换行星',
    desc: '特写中握拳并移动手掌可托住天体旋转观察；握拳快速左右横挥切换上一个/下一个天体：向右挥前一颗，向左挥后一颗，顺序是太阳→水星→…→海王星。',
    glyph: '✊',
    effect: 'ROTATE / SWIPE',
  },
  {
    title: '地球特写 · 1 / 2 / 3 指',
    desc: '在地球特写中比 1 根手指看原生态，2 根手指看完整磁层，3 根手指看范艾伦辐射带；也可以点击顶部按钮。',
    glyph: '☝',
    effect: 'EARTH LAYERS',
  },
];

let tutorialAfter = null;
let tutorialIndex = 0;
let tutorialReturnFocus = null;

function tutorialSeen() {
  try {
    return sessionStorage.getItem('solar-tutorial-seen') === '1';
  } catch {
    return false;
  }
}

function markTutorialSeen() {
  try {
    sessionStorage.setItem('solar-tutorial-seen', '1');
  } catch {
    // ignore storage failures in privacy mode
  }
}

function openTutorial({ after = null } = {}) {
  const panel = document.getElementById('tutorial-panel');
  if (!panel) {
    if (after) after();
    return;
  }
  tutorialAfter = after;
  tutorialIndex = 0;
  tutorialReturnFocus = document.activeElement;
  renderTutorial();
  panel.hidden = false;
  document.getElementById('tutorial-next-btn')?.focus();
}

function closeTutorial({ runAfter = true } = {}) {
  const panel = document.getElementById('tutorial-panel');
  if (panel) panel.hidden = true;
  markTutorialSeen();
  const after = tutorialAfter;
  tutorialAfter = null;
  if (tutorialReturnFocus?.isConnected) tutorialReturnFocus.focus();
  if (runAfter && after) after();
}

function renderTutorial() {
  const step = TUTORIAL_STEPS[tutorialIndex];
  const counter = document.getElementById('tutorial-counter');
  const title = document.getElementById('tutorial-title');
  const desc = document.getElementById('tutorial-desc');
  const glyph = document.getElementById('tutorial-glyph');
  const effect = document.getElementById('tutorial-effect');
  const prev = document.getElementById('tutorial-prev-btn');
  const next = document.getElementById('tutorial-next-btn');
  if (!step) return;
  if (counter) counter.textContent = `${String(tutorialIndex + 1).padStart(2, '0')} / ${String(TUTORIAL_STEPS.length).padStart(2, '0')}`;
  if (title) title.textContent = step.title;
  if (desc) desc.textContent = step.desc;
  if (glyph) glyph.textContent = step.glyph;
  if (effect) effect.textContent = step.effect;
  if (prev) prev.disabled = tutorialIndex === 0;
  if (next) next.textContent = tutorialIndex === TUTORIAL_STEPS.length - 1
    ? (tutorialAfter ? '开启手势之旅' : '完成')
    : '下一步';
}

function simulateTutorialStep() {
  if (!stage) return;
  if (state.phase === 'intro' || state.phase === 'error') {
    enterDemo({ announce: false });
  }
  switch (tutorialIndex) {
    case 0:
      stage.setZoom(Math.min(1.75, (stage.zoom || 1) * 1.28));
      ui.toast('手掌靠近镜头继续拉近 · 离远拉远');
      break;
    case 1:
      state.tutorialLook = { x: 0.55, y: 0.1 };
      state.tutorialLookUntil = performance.now() + 1000;
      window.setTimeout(() => {
        state.tutorialLookUntil = 0;
      }, 1000);
      ui.toast('手掌向左 → 视角向左');
      break;
    case 2:
      openFocus('saturn');
      ui.toast('捏一下 → 拉入土星特写');
      break;
    case 3:
      openFocus('venus');
      window.setTimeout(() => {
        if (state.phase === 'focus') switchFocus(-1);
      }, 850);
      ui.toast('握拳向右挥 → 前一颗（水星）');
      break;
    case 4:
      openFocus('earth');
      window.setTimeout(() => setEarthLayer('magnetic'), 650);
      ui.toast('比 2 根手指 → 完整磁层');
      break;
    default:
      break;
  }
}

function bindTutorialControls() {
  document.getElementById('tutorial-next-btn')?.addEventListener('click', () => {
    if (tutorialIndex >= TUTORIAL_STEPS.length - 1) {
      closeTutorial({ runAfter: true });
      return;
    }
    tutorialIndex += 1;
    renderTutorial();
  });
  document.getElementById('tutorial-prev-btn')?.addEventListener('click', () => {
    tutorialIndex = Math.max(0, tutorialIndex - 1);
    renderTutorial();
  });
  document.getElementById('tutorial-try-btn')?.addEventListener('click', simulateTutorialStep);
  document.getElementById('tutorial-close-btn')?.addEventListener('click', () => closeTutorial({ runAfter: true }));
  document.getElementById('tutorial-open-btn')?.addEventListener('click', () => openTutorial({ after: null }));
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !document.getElementById('tutorial-panel')?.hidden) {
      event.preventDefault();
      closeTutorial({ runAfter: true });
    }
  });
}

bindTutorialControls();


function boot() {
  try {
    stage = createSceneStage({
      canvas,
      runtime,
      initialDate: new Date(state.simMs),
      scaleMode: state.scaleMode,
    });
    stage.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);

    handControllers = [
      new HandController({ pinch: { ...CONFIG.hand.pinch } }),
    ];
    handController = handControllers[0];
    handOverlay = new HandOverlay(overlayCanvas);
    handOverlay.resize();
    buildBodyLabels();

    applyScaleMode(state.scaleMode, { silent: true });
    ui.setSpeed(state.speedIndex, SPEED_LABELS[state.speedIndex] || '');
    ui.setOrbit(state.orbit);
    ui.setParticles(runtime.totalParticles);
    ui.setDate(formatDate(state.simMs));

    if (runtime.startPlanet && BODY_BY_ID[runtime.startPlanet]) {
      openFocus(runtime.startPlanet, { immediate: true, fromBoot: true });
    } else if (runtime.startInDemo) {
      enterDemo({ announce: false, fromBoot: true });
    } else {
      setPhase('intro');
      ui.setStatus('待机 · 摄像头未启用', 'ready');
      ui.setHint('点击「启动观测」使用手势；也可以先进入演示模式');
      ui.setGesture({ label: '等待开始', value: '点击启动观测', fill: 0, handVisible: false });
    }

    window.addEventListener('resize', queueResize, { passive: true });
    window.addEventListener('orientationchange', queueResize, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) state.lastPointerAt = 0;
    });
    bindPointerControls();
    bindKeyboardControls();
    earthLayerButton?.addEventListener('click', cycleEarthLayer);
  
    state.booted = true;
    stage.update({
      dt: 0,
      time: 0,
      date: new Date(state.simMs),
      lookX: 0,
      lookY: 0,
      idle: true,
    });
    stage.render();
    updateBodyLabels();
    requestAnimationFrame(frame);
  } catch (error) {
    console.error('[SolarSystem] boot failed', error);
    state.phase = 'error';
    ui.setPhase('error');
    ui.setStatus('3D 场景启动失败', 'error');
    ui.showError({
      title: '无法启动 3D 观测台',
      message: 'WebGL 初始化失败，可能是浏览器禁用了硬件加速。',
      hint: '请开启浏览器硬件加速，或使用最新版 Chrome / Edge 后刷新页面。',
      code: String(error?.message || error).slice(0, 120),
    });
    state.ready = true;
  }
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

function setPhase(next) {
  state.phase = next;
  ui.setPhase(next);
  updateBodyLabelVisibility();
}

function enterDemo({ announce = false, fromBoot = false } = {}) {
  if (!stage) return;
  stopCamera();
  state.autoDemo = true;
  state.cameraState = 'idle';
  state.pinchHold = null;
  state.pinchRotate = null;
  if (!fromBoot) {
    stage.setOverview();
    ui.hideFocus();
  }
  setPhase('overview');
  state.activePlanetId = state.activePlanetId || INITIAL_PLANET_ID;
  ui.setActivePlanet(state.activePlanetId);
  ui.setStatus('演示模式 · 鼠标 / 触控', 'demo');
  ui.setHint('拖动旋转 · 滚轮缩放 · 点击行星进入特写');
  ui.setGesture({
    label: '鼠标演示',
    value: '拖动旋转 · 滚轮缩放',
    fill: 0.45,
    zoom: 1 / stage.zoom,
    handVisible: false,
  });
  ui.hideLoading();
  if (announce) ui.toast('演示模式：鼠标拖动旋转，点击行星进入特写');
  updateUrl();
}

function startCamera() {
  if (state.cameraBusy) return;
  if (state.cameraState === 'running') {
    if (state.phase !== 'overview') goOverview();
    return;
  }
  if (!state.booted || !stage) return;

  state.cameraBusy = true;
  state.cameraState = 'starting';
  state.cameraSession += 1;
  const session = state.cameraSession;
  if (startButton) startButton.disabled = true;

  setPhase('loading');
  ui.setLoading('正在请求摄像头权限…');
  ui.setStatus('正在请求摄像头', 'ready');
  ui.setHint('画面只在本地浏览器处理，不会上传');
  ui.hideError();

  if (!handTracker) {
    handTracker = new HandTracker({
      video,
      onFrame: handleHandFrame,
      onStatus: handleTrackerStatus,
      onError: handleTrackerError,
      maxHands: 1,
    });
  }

  handTracker
    .start()
    .then(() => {
      if (session !== state.cameraSession) return;
      if (state.phase === 'error') return;
      state.cameraState = 'running';
      state.autoDemo = false;
      state.cameraBusy = false;
      startedCamera = true;
      if (startButton) startButton.disabled = false;
      goOverview();
      ui.hideLoading();
      ui.setStatus('手部追踪就绪 · 本地推理', 'live');
      ui.setHint('手靠近放大 · 手远离缩小 · 捏一下选择');
      ui.toast('手部追踪已就绪');
    })
    .catch((error) => {
      if (session !== state.cameraSession) return;
      state.cameraBusy = false;
      if (startButton) startButton.disabled = false;
      showCameraError(error);
    });
}

function goOverview() {
  state.cameraState = state.cameraState === 'running' ? 'running' : state.cameraState;
  state.autoDemo = state.cameraState !== 'running';
  stage.setOverview();
  ui.hideFocus();
  setPhase('overview');
  ui.setActivePlanet(state.activePlanetId);
  ui.setHint(
    state.cameraState === 'running'
      ? '手靠近放大 · 手远离缩小 · 捏一下选择'
      : '拖动旋转 · 滚轮缩放 · 点击行星进入特写',
  );
  updateUrl();
  handControllers.forEach((controller) => controller.reset());
}

function showCameraError(error) {
  state.cameraState = 'error';
  state.cameraSession += 1;
  stopCamera({ keepState: true });
  state.autoDemo = false;
  const info = describeCameraError(error);
  setPhase('error');
  ui.setStatus('摄像头不可用', 'error');
  ui.showError({
    title: info.title,
    message: info.message,
    hint: info.hint,
    code: info.code,
  });
}

function closeError() {
  stopCamera();
  state.cameraState = 'idle';
  state.cameraBusy = false;
  state.autoDemo = false;
  ui.hideError();
  if (stage) {
    stage.setOverview();
    ui.hideFocus();
  }
  setPhase('intro');
  ui.setStatus('待机 · 摄像头未启用', 'ready');
  ui.setHint('点击「启动观测」使用手势；也可以先进入演示模式');
  ui.setGesture({ label: '等待开始', value: '点击启动观测', fill: 0, handVisible: false });
  if (startButton) startButton.disabled = false;
  updateUrl();
}

function stopCamera({ keepState = false } = {}) {
  state.cameraSession += 1;
  state.cameraBusy = false;
  if (handTracker) {
    try {
      handTracker.stop();
    } catch (error) {
      console.warn('[SolarSystem] tracker stop failed', error);
    }
  }
  if (!keepState) state.cameraState = 'idle';
  state.handState = null;
  state.handVisible = false;
  state.lastFrame = null;
  state.lastHandAt = 0;
  if (handOverlay) handOverlay.clear();
  if (startButton) startButton.disabled = false;
}

// ---------------------------------------------------------------------------
// Scene changes
// ---------------------------------------------------------------------------

function handleFocusBack() {
  if (state.phase === 'focus' && state.activePlanetId === 'moon') {
    selectPlanet('earth');
    return;
  }
  backToOverview();
}


function openFocus(planetId, { immediate = false, fromBoot = false } = {}) {
  const planet = BODY_BY_ID[planetId];
  if (!planet || !stage) return;
  state.activePlanetId = planetId;
  state.autoDemo = false;
  state.pinchHold = null;
  state.pinchRotate = null;
  stage.setFocus(planetId);
  if (planetId === 'earth' || planetId === 'moon') {
    stage.bodies.setEarthLayer('none');
    stage.setFocusYawOffset(0);
  }
  if (immediate) stage.snap();
  setPhase('focus');
  ui.setSpeed(state.speedIndex, `自转 ${CONFIG.time.focusSecondsPerDay} 秒/天`);
  if (focusBackButton) {
    focusBackButton.innerHTML =
      planetId === 'moon'
        ? '<span aria-hidden="true">←</span> 返回地球'
        : '<span aria-hidden="true">←</span> 返回太阳系';
  }
  if (focusPrevButton) focusPrevButton.hidden = planetId === 'moon';
  if (focusNextButton) focusNextButton.hidden = planetId === 'moon';
  ui.showFocus(planet);
  ui.setDistanceBand(planetId === 'moon' ? 'earth' : planetId);
  ui.setHint(
    planetId === 'moon'
      ? '捏一下地球返回 · 握拳托住旋转 · 点击地球返回'
      : '握拳托住旋转 · 握拳左右挥换行星 · 返回总览',
  );
  ui.setStatus(`${planet.nameZh} · 特写`, 'live');
  ui.setActivePlanet(planetId);
  updateEarthLayerControl();
  updateUrl();
  if (!fromBoot) ui.toast(`已进入 ${planet.nameZh} 特写`);
}

function updateEarthLayerControl() {
  if (!earthLayerButton) return;
  const isEarth = state.phase === 'focus' && state.activePlanetId === 'earth';
  const mode = stage?.bodies?.earthLayers?.mode ?? 'none';
  earthLayerButton.hidden = !isEarth;
  earthLayerButton.setAttribute('aria-pressed', mode === 'none' ? 'false' : 'true');
  const label = earthLayerButton.querySelector('strong');
  const modeLabel = mode === 'radiation' ? '辐射带' : mode === 'magnetic' ? '磁场' : '原生态';
  if (label) label.textContent = mode === 'radiation' ? '辐射带' : mode === 'magnetic' ? '磁场' : '原生态';
  earthLayerButton.setAttribute('aria-label', `切换地球结构层，当前${modeLabel}`);
}

function applyEarthYaw(mode) {
  if (!stage) return;
  if (mode === 'magnetic') stage.setFocusYaw(0.35);
  else if (mode === 'radiation') stage.setFocusYawOffset(0.5);
  else stage.setFocusYawOffset(0);
}

function cycleEarthLayer() {
  if (!stage || state.phase !== 'focus' || state.activePlanetId !== 'earth') return;
  const previous = stage.bodies.earthLayers?.mode ?? 'none';
  const mode = stage.bodies.cycleEarthLayer();
  applyEarthYaw(mode);
  if (previous === 'none' && mode !== 'none') {
    state.earthZoomBeforeLayers = stage.zoom;
    stage.setZoom(mode === 'magnetic' ? (runtime.mobile ? 1.35 : 2.2) : (runtime.mobile ? 1.05 : 1.25));
  } else if (mode === 'none') {
    stage.setZoom(state.earthZoomBeforeLayers ?? 1);
  } else {
    stage.setZoom(mode === 'magnetic' ? (runtime.mobile ? 1.35 : 2.2) : (runtime.mobile ? 1.05 : 1.25));
  }
  updateEarthLayerControl();
  const messages = {
    none: '原生态地球 · 真实昼夜与云层',
    radiation: '范艾伦辐射带：内带高能质子，外带电子；1/2/3 指切换',
    magnetic: '完整磁层：磁层顶、弓激波、磁尾与偶极场线；1/2/3 指切换',
  };
  ui.toast(messages[mode] ?? messages.none);
  ui.setHint(mode === 'radiation' || mode === 'magnetic' ? '地球结构层 · 点击地球切换' : '握拳旋转 · 点击地球查看结构层');
}

function setEarthLayer(mode) {
  if (!stage || state.phase !== 'focus' || state.activePlanetId !== 'earth') return;
  const previous = stage.bodies.earthLayers?.mode ?? 'none';
  if (previous === mode) return;
  stage.bodies.setEarthLayer(mode);
  applyEarthYaw(mode);
  if (previous === 'none' && mode !== 'none') {
    state.earthZoomBeforeLayers = stage.zoom;
    stage.setZoom(mode === 'magnetic' ? (runtime.mobile ? 1.35 : 2.2) : (runtime.mobile ? 1.05 : 1.25));
  } else if (mode === 'none') {
    stage.setZoom(state.earthZoomBeforeLayers ?? 1);
  } else {
    stage.setZoom(mode === 'magnetic' ? (runtime.mobile ? 1.35 : 2.2) : (runtime.mobile ? 1.05 : 1.25));
  }
  updateEarthLayerControl();
}

function updateEarthModeFromHand(hand, now) {
  if (!hand || !hand.visible || state.phase !== 'focus' || state.activePlanetId !== 'earth') {
    state.earthFingerCandidate = null;
    return;
  }
  const count = hand.fingerCount;
  const mode = count === 1 ? 'none' : count === 2 ? 'magnetic' : count === 3 ? 'radiation' : null;
  if (!mode) {
    state.earthFingerCandidate = null;
    return;
  }
  if (!state.earthFingerCandidate || state.earthFingerCandidate.mode !== mode) {
    state.earthFingerCandidate = { mode, since: now };
    return;
  }
  if (now - state.earthFingerCandidate.since < 420) return;
  if ((stage.bodies.earthLayers?.mode ?? 'none') !== mode) {
    setEarthLayer(mode);
    const labels = { none: '原生态地球', magnetic: '磁场模型', radiation: '辐射带模型' };
    ui.toast(`已切换 · ${labels[mode]}`);
  }
  state.earthFingerCandidate = null;
}

function selectPlanet(planetId) {
  if (!BODY_BY_ID[planetId] || !stage) return;
  openFocus(planetId);
}

function switchFocus(direction) {
  if (!stage) return;
  if (state.phase !== 'focus') return;
  // The Moon is a satellite, not part of the eight-planet cycle. Return early
  // so a fist swipe in the Moon view never jumps to Mercury/Venus.
  if (state.activePlanetId === 'moon') return;
  if (state.activePlanetId === 'halley') {
    openFocus(direction > 0 ? PLANETS[0].id : PLANETS[PLANETS.length - 1].id);
    return;
  }
  const index = FOCUS_ORDER.findIndex((body) => body.id === state.activePlanetId);
  const current = index < 0 ? 0 : index;
  const next = (current + direction + FOCUS_ORDER.length) % FOCUS_ORDER.length;
  openFocus(FOCUS_ORDER[next].id);
}

function backToOverview() {
  if (!stage) return;
  stage.setOverview();
  ui.hideFocus();
  setPhase('overview');
  ui.setSpeed(state.speedIndex, SPEED_LABELS[state.speedIndex] || '');
  ui.setHint(
    state.cameraState === 'running'
      ? '手靠近放大 · 手远离缩小 · 捏一下选择'
      : '拖动旋转 · 滚轮缩放 · 点击行星进入特写',
  );
  updateUrl();
  ui.setActivePlanet(state.activePlanetId);
  updateEarthLayerControl();
}

function handleDistanceBody(id) {
  if (id === 'sun') {
    selectPlanet('sun');
    return;
  }
  selectPlanet(id);
}

function toggleScale() {
  const next = state.scaleMode === 'true' ? 'demo' : 'true';
  applyScaleMode(next);
  ui.toast(
    next === 'true'
      ? '真实距离模式：轨道间距按 AU 线性排列，行星半径仍为教学放大'
      : '教学压缩模式：保留轨道顺序与偏心率，便于同屏观察',
  );
}

function applyScaleMode(mode, { silent = false } = {}) {
  if (!stage) return;
  state.scaleMode = mode === 'true' ? 'true' : 'demo';
  stage.setScaleMode(state.scaleMode);
  ui.setScale(state.scaleMode, state.scaleMode === 'true' ? '真实距离' : '教学压缩');
  updateUrl();
  if (!silent) stage.snap();
}

function toggleOrbit(enabled) {
  state.orbit = Boolean(enabled);
  if (stage) stage.bodies.setOrbitVisible(state.orbit);
  ui.setOrbit(state.orbit);
}

function cycleSpeed() {
  const next = (state.speedIndex + 1) % SPEEDS.length;
  setSpeedIndex(next);
  ui.toast(`时间速度：${SPEED_LABELS[next]}`);
}

function setSpeedIndex(index) {
  state.speedIndex = clamp(Number(index) || 0, 0, SPEEDS.length - 1);
  ui.setSpeed(
    state.speedIndex,
    state.phase === 'focus'
      ? `自转 ${CONFIG.time.focusSecondsPerDay} 秒/天`
      : SPEED_LABELS[state.speedIndex],
  );
}

function setDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return;
  state.simMs = date.getTime();
  ui.setDate(formatDate(state.simMs));
  if (stage) stage.snap();
}

// ---------------------------------------------------------------------------
// Share / URL / help
// ---------------------------------------------------------------------------

function shareUrl() {
  const url = new URL(window.location.href);
  url.search = '';
  if (state.phase === 'focus' && state.activePlanetId) url.searchParams.set('planet', state.activePlanetId);
  if (state.scaleMode === 'true') url.searchParams.set('scale', 'true');
  if (state.cameraState !== 'running') url.searchParams.set('demo', '1');
  return url.toString();
}

function updateUrl() {
  try {
    const url = new URL(window.location.href);
    if (state.phase === 'focus' && state.activePlanetId) url.searchParams.set('planet', state.activePlanetId);
    else url.searchParams.delete('planet');
    if (state.scaleMode === 'true') url.searchParams.set('scale', 'true');
    else url.searchParams.delete('scale');
    window.history.replaceState(null, '', url);
  } catch {
    /* file:// or restricted history — URL sync is optional */
  }
}

async function share() {
  const url = shareUrl();
  ui.setShareState('busy');
  if (window.matchMedia?.('(pointer: coarse)').matches && navigator.share) {
    try {
      await navigator.share({
        title: '太阳系 · 粒子天文台',
        text: '用手漫游太阳系，捏合拉近一颗行星。',
        url,
      });
      ui.setShareState('done');
      return;
    } catch (error) {
      if (error?.name === 'AbortError') {
        ui.setShareState('idle');
        return;
      }
    }
  }
  await copyText(url);
  ui.setShareState('done');
  ui.toast('链接已复制 · 打开即是同一幕');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand?.('copy') ?? false;
    textarea.remove();
    return ok;
  }
}

// ---------------------------------------------------------------------------
// Camera + hand input
// ---------------------------------------------------------------------------

function handleTrackerStatus(status) {
  if (!status) return;
  if (state.phase !== 'loading') return;
  const message =
    status.phase === 'camera'
      ? '正在连接摄像头…'
      : status.phase === 'model'
        ? '正在加载本地手部模型…'
        : status.phase === 'ready'
          ? '手部模型已就绪'
          : loadingMessage;
  loadingMessage = message;
  ui.setLoading(message);
  ui.setStatus(message, 'ready');
}

function handleTrackerError(error) {
  if (state.phase === 'loading' || state.phase === 'overview' || state.phase === 'focus') {
    showCameraError(error);
  }
}

function handleHandFrame(frame) {
  if (!frame || state.cameraState !== 'running') return;
  state.lastFrame = frame;
  const rawHands = Array.isArray(frame.hands) && frame.hands.length
    ? frame.hands
    : frame.landmarks
      ? [{ landmarks: frame.landmarks }]
      : [];
  const now = performance.now();
  const hands = handControllers.map((controller, index) => {
    const raw = rawHands[index];
    return controller.update(raw?.landmarks || null, frame.aspect, frame.timestampMs);
  }).filter((hand) => hand?.visible);
  state.handStates = hands;
  state.handState = hands[0] || null;
  if (hands.length >= 2) {
    if (!state.secondHandSince) state.secondHandSince = now;
    state.handVisible = true;
    state.lastHandAt = now;
  } else {
    state.secondHandSince = 0;
    if (hands[0]) {
      state.handVisible = true;
      state.lastHandAt = now;
    }
  }
}

function currentHandState(now) {
  if (state.cameraState !== 'running') return null;
  if (!state.handState || !state.handVisible) return null;
  if (now - state.lastHandAt > CONFIG.hand.lostHandMs) {
    state.handVisible = false;
    state.handState = null;
    state.handStates = [];
    state.secondHandSince = 0;
    return null;
  }
  return state.handState;
}

function currentHands(now) {
  if (!currentHandState(now)) return [];
  return state.handStates.filter((hand) => hand?.visible);
}

/**
 * Fist swipe is the only planet-switch gesture in close-up. Keeping it
 * separate from the open-hand wave means palm movement can never change
 * planet while the user is only turning the view.
 */
function updateFistSwipe(hand, now) {
  if (!hand || !hand.visible || !hand.fist || state.phase !== 'focus') {
    state.fistSamples = [];
    return;
  }
  if (state.activePlanetId === 'moon') return;
  if (now < state.fistSwipeCooldownUntil) return;
  state.fistSamples.push({ x: hand.palm.x, y: hand.palm.y, t: now });
  while (state.fistSamples.length && now - state.fistSamples[0].t > 460) {
    state.fistSamples.shift();
  }
  if (state.fistSamples.length < 3) return;
  const first = state.fistSamples[0];
  const last = state.fistSamples[state.fistSamples.length - 1];
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  const xs = state.fistSamples.map((sample) => sample.x);
  const spanX = Math.max(...xs) - Math.min(...xs);
  const elapsed = Math.max(1, now - first.t) / 1000;
  const speed = spanX / elapsed;
  // A fist swipe is a fast, mostly horizontal excursion. Use the full span
  // (not only the first sample) so both directions trigger from any entry
  // point, and allow a little vertical wobble from real hands.
  if (spanX < 0.085 || Math.abs(dy) > spanX * 1.45 || speed < 0.32) return;
  if (Math.abs(dx) < spanX * 0.45) return;
  // User-facing direction: slow swipe from left to right moves backward
  // along Sun → Mercury → … → Neptune (e.g. Venus → Mercury).
  switchFocus(dx > 0 ? -1 : 1);
  state.fistSwipeCooldownUntil = now + 950;
  state.fistSwipeUntil = now + 520;
  state.fistSamples = [];
  state.pinchRotate = null;
}

function pinchScreenPoint(hand) {
  const point = hand.indexTip || hand.pinch?.midpoint;
  if (!point) return null;
  const layout = computeCoverLayout(
    window.innerWidth,
    window.innerHeight,
    state.lastFrame?.videoWidth || window.innerWidth,
    state.lastFrame?.videoHeight || window.innerHeight,
  );
  return {
    x: layout.offsetX + clamp(point.x, 0, 1) * layout.drawnW,
    y: layout.offsetY + clamp(point.y, 0, 1) * layout.drawnH,
  };
}

const PINCH_UI_SELECTOR =
  'button:not([disabled]), a[href], [role="button"], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary';

function clickPinchUi(x, y) {
  const element = document.elementFromPoint(x, y);
  if (!element) return false;
  const target = element.closest(PINCH_UI_SELECTOR);
  if (!target || target.closest('[inert]')) return false;
  target.click();
  return true;
}

/**
 * One shared tap path for real pinch gestures and the debug bridge. This keeps
 * UI clicks, 3D selection, Moon entry and Earth layer cycling identical.
 */
function nearestBodyAt(x, y) {
  if (!stage) return null;
  const positions = stage.labelPositions();
  let best = null;
  let bestDist = Math.max(120, window.innerHeight * 0.16);
  for (const position of positions) {
    if (!position?.visible) continue;
    if (!BODY_BY_ID[position.id]) continue;
    const dist = Math.hypot(position.x - x, position.y - y);
    if (dist < bestDist) {
      bestDist = dist;
      best = position;
    }
  }
  return best;
}

function handlePinchTap(x, y) {
  if (clickPinchUi(x, y)) return 'ui';
  if (!stage) return 'none';
  const hit = stage.pick(x, y) || nearestBodyAt(x, y);
  if (state.phase === 'overview') {
    if (hit) {
      selectPlanet(hit.id);
      return `select:${hit.id}`;
    }
    return 'none';
  }
  if (state.phase === 'focus') {
    if (hit?.id === 'moon' && state.activePlanetId === 'earth') {
      selectPlanet('moon');
      return 'select:moon';
    }
    if (hit?.id === 'earth' && state.activePlanetId === 'moon') {
      selectPlanet('earth');
      return 'select:earth';
    }
    if (state.activePlanetId === 'earth') {
      cycleEarthLayer();
      return 'earth-layer';
    }
  }
  return hit ? `hit:${hit.id}` : 'none';
}

function updatePinchInteraction(hand, now) {
  if (!hand) {
    state.pinchHold = null;
    state.pinchRotate = null;
    return;
  }

  // 捏一下 = 单击：先命中任意可见 UI，再命中 3D 天体；地球特写空场景
  // 额外作为“切换地球结构层”的快捷方式。
  if (hand.pinchStarted && hand.openness > 0.08) {
    const screen = pinchScreenPoint(hand);
    if (screen) {
      const tapped = handlePinchTap(screen.x, screen.y);
      if (tapped === 'ui') state.lastPinchUiAt = now;
      if (tapped !== 'none') state.pinchHold = null;
    }
  }

  if (state.phase === 'overview') {
    state.pinchRotate = null;
    if (!hand.pinch?.active) state.pinchHold = null;
    return;
  }

  if (state.phase === 'focus') {
    // 握拳托住星球：记录拳心作为旋转手柄，不再用捏合拖动。
    if (hand.fist) {
      if (!state.pinchRotate) {
        state.pinchRotate = {
          x: hand.palm.x,
          y: hand.palm.y,
          lookX: state.look.x,
          lookY: state.look.y,
        };
      }
    } else {
      state.pinchRotate = null;
    }
  }
}

function updateHandZoom(hands, dt) {
  const list = Array.isArray(hands) ? hands.filter((hand) => hand?.visible) : [];
  const hand = list[0] || null;
  if (!stage || !hand || state.phase === 'intro') {
    state.handDistanceAnchor = null;
    state.zoomAnchorPalm = null;
    state.twoHandAnchor = null;
    state.lastPalmScale = 0;
    state.zoomStillFrames = 0;
    state.twoHandLastScale = 0;
    state.twoHandStillFrames = 0;
    state.zoomLastMoveAt = 0;
    state.twoHandLastMoveAt = 0;
    return;
  }

  // Two hands: average their apparent palm size. Both hands moving away make
  // the average smaller (zoom out); both moving closer makes it larger.
  if (list.length >= 2) {
    const scales = list.map((item) => Number(item.palmScale) || 0).filter((value) => value > 0.0001);
    if (!scales.length) return;
    const average = scales.reduce((sum, value) => sum + value, 0) / scales.length;
    const delta = Math.abs(average - state.twoHandLastScale) / Math.max(average, 1e-4);
    state.twoHandLastScale = average;
    const now = performance.now();
    if (delta > 0.008) state.twoHandLastMoveAt = now;
    if (!state.twoHandLastMoveAt) state.twoHandLastMoveAt = now;
    if (delta < 0.008) state.twoHandStillFrames += 1;
    else state.twoHandStillFrames = 0;
    if (now - state.twoHandLastMoveAt > 220 || state.twoHandStillFrames >= 4) {
      // A stopped hand must freeze the camera. Previously the slowly adapting
      // anchor kept zooming after the hand stopped, which made the view drift.
      state.twoHandAnchor = average;
      state.handDistanceAnchor = average;
      return;
    }
    if (!state.twoHandAnchor) state.twoHandAnchor = average;
    const ratio = clamp(average / state.twoHandAnchor, 0.45, 2.2);
    const deadband = CONFIG.hand.zoom.distanceDeadband ?? 0.045;
    if (ratio > 1 + deadband || ratio < 1 - deadband) {
      const rate = Math.log(ratio) * ((CONFIG.hand.zoom.distanceSensitivity ?? 2.6) * 1.45);
      stage.zoomBy(Math.exp(-rate * dt));
      state.twoHandAnchor += (average - state.twoHandAnchor) * Math.min(1, dt * 1.6);
    } else {
      state.twoHandAnchor += (average - state.twoHandAnchor) * Math.min(1, dt * 2.2);
    }
    state.handDistanceAnchor = average;
    return;
  }

  state.twoHandAnchor = null;
  if (hand.fist || hand.pinch?.active) return;
  const scale = Number(hand.palmScale) || 0;
  if (scale <= 0.0001) return;
  // The apparent palm size is a better depth cue than finger pose: moving the
  // hand toward the camera makes the tracked palm (and its 21 nodes) larger.
  // Use a slowly adapting anchor so a held hand does not zoom forever, while a
  // clear in/out motion still produces a strong, immediate response.
  const previousScale = state.lastPalmScale;
  state.lastPalmScale = scale;
  const scaleDelta = previousScale > 0 ? Math.abs(scale - previousScale) / Math.max(previousScale, 1e-4) : 1;
  const now = performance.now();
  if (scaleDelta > 0.008) state.zoomLastMoveAt = now;
  if (!state.zoomLastMoveAt) state.zoomLastMoveAt = now;
  if (scaleDelta < 0.008) state.zoomStillFrames += 1;
  else state.zoomStillFrames = 0;
  if (now - state.zoomLastMoveAt > 220 || state.zoomStillFrames >= 4) {
    // Hand stopped: snap the anchor and do not zoom at all. This removes the
    // "let go and it slowly keeps zooming" drift.
    state.handDistanceAnchor = scale;
    return;
  }
  if (!state.handDistanceAnchor) state.handDistanceAnchor = scale;
  const ratio = clamp(scale / state.handDistanceAnchor, 0.45, 2.8);
  const deadband = CONFIG.hand.zoom.distanceDeadband ?? 0.045;
  if (ratio > 1 + deadband || ratio < 1 - deadband) {
    const rate = Math.log(ratio) * (CONFIG.hand.zoom.distanceSensitivity ?? 2.6);
    stage.zoomBy(Math.exp(-rate * dt));
    state.handDistanceAnchor += (scale - state.handDistanceAnchor) * Math.min(1, dt * 0.35);
  } else {
    state.handDistanceAnchor += (scale - state.handDistanceAnchor) * Math.min(1, dt * 2.4);
  }
}

// ---------------------------------------------------------------------------
// Camera framing + look
// ---------------------------------------------------------------------------

function updateLook(dt, hand, now) {
  const pointerActive = now - state.lastPointerAt < 3200;
  let desiredX = 0;
  let desiredY = 0;

  if (now < state.tutorialLookUntil) {
    desiredX = state.tutorialLook.x;
    desiredY = state.tutorialLook.y;
  } else if (state.phase === 'intro') {
    desiredX = Math.sin(state.elapsed * 0.075) * 0.32;
    desiredY = Math.sin(state.elapsed * 0.11) * 0.12;
  } else if (hand) {
    // 用户要求：手往左，视角也往左；因此屏幕 x 与 orbit yaw 取反。
    desiredX = -clamp((hand.palm.x - 0.5) / 0.28, -1, 1);
    desiredY = clamp((hand.palm.y - 0.5) / 0.24, -1, 1);
    if (state.phase === 'focus' && hand.fist && state.pinchRotate) {
      if (now < state.fistSwipeUntil) {
        desiredX = state.look.x;
        desiredY = state.look.y;
      } else {
        desiredX = state.pinchRotate.lookX + (hand.palm.x - state.pinchRotate.x) * 3.2;
        desiredY = state.pinchRotate.lookY + (hand.palm.y - state.pinchRotate.y) * 2.6;
      }
    }
    state.manualLook.x = 0;
    state.manualLook.y = 0;
  } else if (pointerActive) {
    const hoverX = (state.pointer.x - 0.5) * 1.6;
    const hoverY = (state.pointer.y - 0.5) * 1.1;
    desiredX = hoverX + state.manualLook.x;
    desiredY = hoverY + state.manualLook.y;
  } else if (state.autoDemo) {
    desiredX = Math.sin(state.elapsed * 0.18) * 0.42;
    desiredY = Math.sin(state.elapsed * 0.13) * 0.2;
  } else {
    desiredX = state.manualLook.x;
    desiredY = state.manualLook.y;
  }

  desiredX = clamp(desiredX, -1.45, 1.45);
  desiredY = clamp(desiredY, -1.15, 1.15);
  const alpha = 1 - Math.exp(-dt * 6.5);
  state.look.x += (desiredX - state.look.x) * alpha;
  state.look.y += (desiredY - state.look.y) * alpha;
}

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------

function frame(now) {
  requestAnimationFrame(frame);
  if (!stage || !state.booted) return;

  const rawDt = (now - lastFrameTime) / 1000;
  lastFrameTime = now;
  const dt = clamp(Number.isFinite(rawDt) ? rawDt : 0, 0, 0.05);
  state.elapsed += dt;
  state.frames += 1;
  const instantFps = dt > 0 ? 1 / dt : 60;
  state.fps = state.fps * 0.92 + instantFps * 0.08;

  if (!document.hidden) {
    const selectedDaysPerSecond = SPEEDS[state.speedIndex] || 0;
    const daysPerSecond = selectedDaysPerSecond <= 0
      ? 0
      : state.phase === 'focus'
        ? 1 / CONFIG.time.focusSecondsPerDay
        : selectedDaysPerSecond;
    if (daysPerSecond > 0) state.simMs += dt * daysPerSecond * 86400000;
    const currentDate = new Date(state.simMs);
    const hands = currentHands(now);
    const hand = hands[0] || null;
    updateFistSwipe(hand, now);
    updatePinchInteraction(hand, now);
    updateEarthModeFromHand(hand, now);
    updateHandZoom(hand ? [hand] : [], dt);
    updateLook(dt, hand, now);

    stage.update({
      dt,
      time: state.elapsed,
      date: currentDate,
      lookX: state.look.x,
      lookY: state.look.y,
      idle: !hand,
    });

    if (handOverlay) {
      handOverlay.update({
        landmarks: state.lastFrame?.landmarks || null,
        videoWidth: state.lastFrame?.videoWidth || 0,
        videoHeight: state.lastFrame?.videoHeight || 0,
        state: hand,
        time: state.elapsed,
        visible:
          runtime.showHandOverlay &&
          (state.phase === 'overview' || state.phase === 'focus') &&
          state.cameraState === 'running',
        showNodes: true,
      });
    }

    stage.render();

    state.hudAccumulator += dt;
    if (state.hudAccumulator >= 1 / CONFIG.ui.hudHz) {
      state.hudAccumulator = 0;
      updateHud(hand);
    }

    state.labelAccumulator += dt;
    if (state.labelAccumulator >= 0.1) {
      state.labelAccumulator = 0;
      updateBodyLabels();
    }

    state.dateAccumulator += dt;
    if (state.dateAccumulator >= 0.5) {
      state.dateAccumulator = 0;
      ui.setDate(formatDate(state.simMs));
    }
  }

  if (!state.ready) {
    state.ready = true;
    ui.setParticles(runtime.totalParticles);
  }
}

function updateHud(hand) {
  const visible = Boolean(hand?.visible) && state.handVisible;
  const zoom = 1 / Math.max(0.001, stage.zoom);
  const gesture = hand?.gesture || (state.autoDemo ? 'mouse' : 'idle');
  const label =
    {
      open: '手掌张开',
      together: '四指并拢',
      fist: '握拳托住 / 横挥换行星',
      point: '食指指向',
      pinch: '捏合选择',
      wave: '挥手切换',
      mouse: '鼠标演示',
      idle: '待机',
    }[gesture] || '追踪中';
  const value = visible ? `${hand?.fingerCount ?? 0} 指 · ${Math.round((hand?.openness || 0) * 100)}%` : state.autoDemo ? '拖动旋转' : '等待手掌';
  const hint =
    state.phase === 'focus'
      ? '握拳托住旋转 · 握拳左右挥换行星 · 返回总览'
      : state.cameraState === 'running'
        ? '张开放大 · 并拢缩小 · 捏一下选择'
        : '拖动旋转 · 滚轮缩放';

  ui.setGesture({
    label,
    value,
    fill: visible ? hand.openness : state.autoDemo ? 0.45 : 0,
    zoom,
    hint,
    handVisible: visible,
  });
  ui.setZoom(zoom);
  ui.setFps(state.fps);
  ui.setSpeed(state.speedIndex, SPEED_LABELS[state.speedIndex] || '');
  ui.setScale(state.scaleMode, state.scaleMode === 'true' ? '真实距离' : '教学压缩');
  ui.setOrbit(state.orbit);
  ui.setDate(formatDate(state.simMs));
}

// ---------------------------------------------------------------------------
// DOM labels
// ---------------------------------------------------------------------------

function buildBodyLabels() {
  const nodes = [];
  const items = [
    { id: 'sun', name: SUN.nameZh || '太阳', nameEn: 'SUN' },
    ...PLANETS.map((planet) => ({ id: planet.id, name: planet.nameZh, nameEn: planet.nameEn })),
    { id: 'moon', name: '月球', nameEn: 'MOON' },
    { id: 'halley', name: '哈雷彗星', nameEn: 'HALLEY' },
  ];
  for (const item of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'body-label';
    button.dataset.bodyId = item.id;
    button.tabIndex = -1;
    button.setAttribute('aria-label', `${item.name} · ${item.nameEn}`);
    button.style.pointerEvents = 'auto';
    button.style.cursor = 'pointer';
    button.style.background = 'transparent';
    button.style.border = '0';
    button.style.padding = '0';
    button.style.font = 'inherit';
    button.style.color = 'inherit';
    button.innerHTML = `<span class="body-label__dot" aria-hidden="true"></span><span class="body-label__text">${item.name}<em>${item.nameEn}</em></span>`;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (state.phase === 'overview' && item.id !== 'sun' && item.id !== 'moon') {
        selectPlanet(item.id);
      } else if (
        item.id === 'moon' &&
        state.phase === 'focus' &&
        state.activePlanetId === 'earth'
      ) {
        selectPlanet('moon');
      } else if (
        item.id === 'earth' &&
        state.phase === 'focus' &&
        state.activePlanetId === 'moon'
      ) {
        selectPlanet('earth');
      }
    });
    nodes.push(button);
    labelNodes.set(item.id, { node: button, item });
  }
  labels = nodes;
  ui.setLabels(nodes);
  updateBodyLabelVisibility();
}

function updateBodyLabels() {
  if (!stage || !labels.length) return;
  const positions = stage.labelPositions();
  const byId = new Map(positions.map((position) => [position.id, position]));
  for (const [id, entry] of labelNodes) {
    const position = byId.get(id);
    const earthView =
      state.phase === 'focus' &&
      (state.activePlanetId === 'earth' || state.activePlanetId === 'moon');
    const allowed =
      (state.phase === 'overview' && id !== 'moon') ||
      (earthView && (id === 'moon' || id === 'earth'));
    const visible =
      allowed &&
      Boolean(position?.visible) &&
      (id === 'halley' || id === 'moon' || position.screenRadius > 0.012 * window.innerHeight);
    entry.node.classList.toggle('is-visible', visible);
    if (visible) {
      entry.node.style.left = `${position.x}px`;
      entry.node.style.top = `${position.y}px`;
    }
  }
}

function updateBodyLabelVisibility() {
  if (!labels.length) return;
  if (stage) {
    updateBodyLabels();
    return;
  }
  for (const node of labels) node.classList.remove('is-visible');
}

// ---------------------------------------------------------------------------
// Pointer / wheel / keyboard
// ---------------------------------------------------------------------------

function bindPointerControls() {
  if (!canvas) return;
  canvas.addEventListener('pointerdown', (event) => {
    state.pointer.down = true;
    state.pointer.moved = 0;
    state.pointer.lastX = event.clientX;
    state.pointer.lastY = event.clientY;
    state.pointer.x = event.clientX / window.innerWidth;
    state.pointer.y = event.clientY / window.innerHeight;
    state.lastPointerAt = performance.now();
    state.autoDemo = false;
    state.dragPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (state.dragPointers.size === 2) {
      const [a, b] = [...state.dragPointers.values()];
      state.touchDistance = Math.hypot(a.x - b.x, a.y - b.y);
    }
    canvas.setPointerCapture?.(event.pointerId);
  });

  canvas.addEventListener('pointermove', (event) => {
    state.pointer.x = event.clientX / window.innerWidth;
    state.pointer.y = event.clientY / window.innerHeight;
    state.lastPointerAt = performance.now();
    const previous = state.dragPointers.get(event.pointerId);
    if (previous) {
      state.dragPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (state.dragPointers.size >= 2) {
        const [a, b] = [...state.dragPointers.values()];
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (state.touchDistance > 0) stage.zoomBy(state.touchDistance / Math.max(distance, 1));
        state.touchDistance = distance;
        return;
      }
      const dx = event.clientX - previous.x;
      const dy = event.clientY - previous.y;
      state.pointer.moved += Math.abs(dx) + Math.abs(dy);
      if (state.pointer.down) {
        state.manualLook.x = clamp(state.manualLook.x - dx * 0.0036, -1.25, 1.25);
        state.manualLook.y = clamp(state.manualLook.y - dy * 0.0028, -0.95, 0.95);
      }
    }
  });

  const endPointer = (event) => {
    const wasDown = state.pointer.down;
    state.pointer.down = false;
    state.dragPointers.delete(event.pointerId);
    if (state.dragPointers.size < 2) state.touchDistance = 0;
    if (!wasDown) return;
    if (state.pointer.moved < 8 && state.phase === 'overview') {
      const hit = stage?.pick(event.clientX, event.clientY);
      if (hit) selectPlanet(hit.id);
    } else if (
      state.pointer.moved < 8 &&
      state.phase === 'focus' &&
      state.activePlanetId === 'earth'
    ) {
      const hit = stage?.pick(event.clientX, event.clientY);
      if (hit?.id === 'earth') cycleEarthLayer();
    }
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      state.autoDemo = false;
      stage?.zoomBy(Math.exp(-event.deltaY * 0.0011));
      state.lastPointerAt = performance.now();
    },
    { passive: false },
  );

  canvas.addEventListener('pointerleave', () => {
    state.lastPointerAt = 0;
  });
}

function bindKeyboardControls() {
  window.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return;
    if (ui?.state?.modal) return;
    const target = event.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

    if (event.key >= '1' && event.key <= '8') {
      const planet = PLANETS[Number(event.key) - 1];
      if (planet) {
        event.preventDefault();
        selectPlanet(planet.id);
      }
      return;
    }
    if (event.key === '0' || event.key === 'Home') {
      event.preventDefault();
      backToOverview();
      return;
    }
    if ((event.key === 'h' || event.key === 'H') && state.phase === 'overview') {
      event.preventDefault();
      selectPlanet('halley');
      return;
    }
    if (event.key === 'Escape') {
      if (state.phase === 'focus') {
        event.preventDefault();
        backToOverview();
      }
      return;
    }
    if (event.key === 'ArrowRight' && state.phase === 'focus') {
      event.preventDefault();
      switchFocus(1);
      return;
    }
    if (event.key === 'ArrowLeft' && state.phase === 'focus') {
      event.preventDefault();
      switchFocus(-1);
      return;
    }
    if ((event.key === 'l' || event.key === 'L') && state.phase === 'focus' && state.activePlanetId === 'earth') {
      event.preventDefault();
      cycleEarthLayer();
      return;
    }
    if (event.key === ' ') {
      event.preventDefault();
      if (state.speedIndex === 0) setSpeedIndex(CONFIG.ui.defaultSpeedIndex);
      else setSpeedIndex(0);
      return;
    }
    if (event.key === 's' || event.key === 'S') {
      event.preventDefault();
      toggleScale();
      return;
    }
    if (event.key === 'o' || event.key === 'O') {
      event.preventDefault();
      toggleOrbit(!state.orbit);
    }
  });
}

// ---------------------------------------------------------------------------
// Debug bridge
// ---------------------------------------------------------------------------

const bridge = {
  get ready() {
    return state.ready;
  },
  enterDemo: (options) => enterDemo(options),
  startCamera: () => startCamera(),
  selectPlanet: (id) => selectPlanet(id),
  back: () => backToOverview(),
  setScale: (mode) => applyScaleMode(mode),
  setSpeed: (index) => setSpeedIndex(index),
  setDate: (value) => setDate(value),
  setLook: (x, y) => {
    state.manualLook.x = clamp(Number(x) || 0, -1.2, 1.2);
    state.manualLook.y = clamp(Number(y) || 0, -1, 1);
    state.pointer.x = 0.5;
    state.pointer.y = 0.5;
    state.lastPointerAt = performance.now();
  },
  setZoom: (value) => stage?.setZoom(value),
  cycleEarthLayer: () => cycleEarthLayer(),
  tapAt: (x, y) => handlePinchTap(Number(x) || 0, Number(y) || 0),
  getState: () => readState(),
  triggerError: (code = 'CAMERA_FAILED') => {
    const error = new Error('Debug camera failure');
    error.code = code;
    showCameraError(error);
  },
};
window.__SOLAR_SYSTEM__ = bridge;
window.__SOLAR_DEBUG__ = () => {
  const list = [];
  if (!stage) return list;
  stage.scene.traverse((object) => {
    if (!(object.isMesh || object.isPoints || object.isSprite || object.isLine)) return;
    const p = new THREE.Vector3();
    object.getWorldPosition(p);
    list.push({
      type: object.type,
      name: object.name,
      visible: object.visible,
      position: [Number(p.x.toFixed(3)), Number(p.y.toFixed(3)), Number(p.z.toFixed(3))],
      scale: [Number(object.scale.x.toFixed(3)), Number(object.scale.y.toFixed(3)), Number(object.scale.z.toFixed(3))],
    });
  });
  return list;
};

function readState() {
  let webgl = false;
  try {
    const context = stage?.renderer?.getContext?.();
    webgl = Boolean(context && !context.isContextLost?.());
  } catch {
    webgl = false;
  }
  const planet = state.activePlanetId ? BODY_BY_ID[state.activePlanetId] : null;
  return {
    phase: state.phase,
    mode: stage?.mode || 'overview',
    focusId: stage?.focusId || null,
    planet: planet ? { id: planet.id, name: planet.nameZh, nameEn: planet.nameEn } : null,
    activePlanetId: state.activePlanetId,
    scaleMode: state.scaleMode,
    orbit: state.orbit,
    particles: runtime.totalParticles,
    earthLayer: stage?.bodies?.earthLayers?.mode || 'none',
    webgl,
    fps: state.fps,
    handVisible: state.handVisible,
    hand: state.handState
      ? {
          visible: state.handState.visible,
          gesture: state.handState.gesture,
          openness: state.handState.openness,
          pinch: state.handState.pinch?.active || false,
        }
      : null,
    camera: {
      state: state.cameraState,
      ready: state.cameraState === 'running',
      busy: state.cameraBusy,
      videoWidth: video?.videoWidth || 0,
      videoHeight: video?.videoHeight || 0,
      hasStream: Boolean(video?.srcObject),
    },
    speedIndex: state.speedIndex,
    daysPerSecond:
      state.phase === 'focus'
        ? 1 / CONFIG.time.focusSecondsPerDay
        : SPEEDS[state.speedIndex] || 0,
    date: formatDate(state.simMs),
    zoom: stage?.zoom || 1,
    distance: stage?.distance || 0,
    yaw: stage?.yaw || 0,
    pitch: stage?.pitch || 0,
    transitioning: Boolean(stage?.transitioning),
  };
}

function queueResize() {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => {
    resizeQueued = false;
    if (!stage) return;
    stage.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
    handOverlay?.resize();
    updateBodyLabels();
  });
}

boot();

