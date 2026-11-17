/**
 * 太阳系 · 粒子天文台 / Solar System Particle Observatory
 * src/handControls.js — 手势控制纯逻辑层（无 DOM、无 three）。
 *
 * ============================================================================
 * 职责
 * ============================================================================
 * 把 MediaPipe Hand Landmarker 的 21 个 normalized landmark 变成太阳系场景可用的
 * 控制信号：
 *
 *   1. `deriveHandNodes(landmarks, aspect)`：一次性得到
 *        - 21 个基础节点 + 5 个衍生节点（26 个 `{id,label,x,y,z,kind}`）
 *        - 掌心（镜像后 0..1）
 *        - palmScale（手掌尺度，宽高比校正后的无量纲值）
 *        - pinchRatio（捏合比，拇指尖 4 ↔ 食指指尖 8 的距离 / 手掌尺度）
 *        - openness（0..1，直接复用根目录 `src/tension.js` 的 computeTension）
 *        - 四指伸展、fingerCount、spread、flat/together/fist/point
 *   2. `HandController`：逐帧状态机，负责镜像坐标、平滑、捏合滞回（2 帧确认）、
 *      左右挥手（窗口位移 / 方向 / 冷却 / 停稳 re-arm）、手丢失重置。
 *
 * 本模块与 `HandTracker` 完全解耦：`HandTracker` 只负责摄像头 + 模型，把一帧
 * `{ landmarks, aspect, timestampMs }` 交给这里即可。所有输入都做防御性校验，
 * 非法数据返回 null / 安全默认值，绝不抛错。
 *
 * ============================================================================
 * 坐标约定
 * ============================================================================
 * MediaPipe 的 normalized 坐标：x,y ∈ 0..1，原点左上，y 向下；z 约与 x 同尺度
 * （负值朝向镜头）。摄像头预览是自拍视角（镜像显示），因此所有对外坐标统一
 * 镜像：  x' = 1 - x,  y' = y  → 0..1，x 向右，y 向下。
 *
 * 距离 / 尺度计算在「宽高比校正空间」里进行（与根目录 tension.js 一致）：
 *   X = x · aspect,  Y = y,  Z = z · aspect
 * aspect = videoWidth / videoHeight。这样手掌在 16:9 / 4:3 / 竖屏下的尺度一致，
 * 捏合比不会随摄像头比例漂移。镜像不改变任何距离。
 *
 * ============================================================================
 * 捏合 / 挥手 阈值（全部可从 CONFIG.hand 读取，也可用构造参数覆盖）
 * ============================================================================
 *   捏合：ratio < startRatio(0.24) 连续 2 帧 → active
 *         ratio > releaseRatio(0.40) 连续 2 帧 → release（滞回）
 *   挥手：最近 windowMs(260) 内掌心 x 位移 > minDx(0.16)，|dy| < maxDy(0.12)，
 *         openness > minOpenness(0.62)，速度 > minSpeed；x 增大 = next；
 *         触发后冷却 cooldownMs(1150)，且手停稳 settleMs(180) 后才重新 arm。
 *
 * 平滑：掌心 EMA alpha 0.14，openness EMA alpha 0.18；捏合比不做平滑，避免延迟。
 */

import { CONFIG } from './config.js';
import { computeTension } from '../../src/tension.js';

// ===========================================================================
// 常量
// ===========================================================================

const LANDMARK_COUNT = 21;
const EPSILON = 1e-6;
const DEFAULT_FRAME_MS = 1000 / 60;
const MIN_FRAME_MS = 1;

/** 5 个衍生控制节点，顺序即 `nodes` 数组尾部的顺序。 */
export const DERIVED_NODE_IDS = Object.freeze([
  'palmCenter',
  'pinchMid',
  'indexTip',
  'thumbTip',
  'palmSpan',
]);

/** 21 个基础节点的 id / 中文短标签（顺序 = MediaPipe landmark 索引）。 */
const BASE_NODE_DEFS = Object.freeze([
  Object.freeze(['wrist', '手腕']),
  Object.freeze(['thumb_cmc', '拇指根']),
  Object.freeze(['thumb_mcp', '拇指掌指']),
  Object.freeze(['thumb_ip', '拇指指间']),
  Object.freeze(['thumb_tip', '拇指尖']),
  Object.freeze(['index_mcp', '食指根']),
  Object.freeze(['index_pip', '食指近节']),
  Object.freeze(['index_dip', '食指远节']),
  Object.freeze(['index_tip', '食指尖']),
  Object.freeze(['middle_mcp', '中指根']),
  Object.freeze(['middle_pip', '中指近节']),
  Object.freeze(['middle_dip', '中指远节']),
  Object.freeze(['middle_tip', '中指尖']),
  Object.freeze(['ring_mcp', '无名指根']),
  Object.freeze(['ring_pip', '无名指近节']),
  Object.freeze(['ring_dip', '无名指远节']),
  Object.freeze(['ring_tip', '无名指尖']),
  Object.freeze(['pinky_mcp', '小指根']),
  Object.freeze(['pinky_pip', '小指近节']),
  Object.freeze(['pinky_dip', '小指远节']),
  Object.freeze(['pinky_tip', '小指尖']),
]);

/** 衍生节点标签（overlay 直接使用；顺序与 DERIVED_NODE_IDS 一致）。 */
const DERIVED_NODE_LABELS = Object.freeze({
  palmCenter: '掌心',
  pinchMid: '捏合',
  indexTip: '食指',
  thumbTip: '拇指',
  palmSpan: '掌幅',
});

/** 掌心 = 手腕(0) + 四个 MCP(5/9/13/17) 的均值。 */
const PALM_INDICES = Object.freeze([0, 5, 9, 13, 17]);

/** 判定「这是一只可用的手」必须存在的关键点。 */
const REQUIRED_INDICES = Object.freeze([0, 4, 5, 8, 9, 13, 17]);

/** 至少需要多少个有效点才认为手可用（容忍部分遮挡 / 单点缺失）。 */
const MIN_VALID_LANDMARKS = 12;

const INDEX_TIP = 8;
const THUMB_TIP = 4;
const WRIST = 0;
const MIDDLE_MCP = 9;
const INDEX_MCP = 5;
const PINKY_MCP = 17;

/** 四指（食指/中指/无名指/小指）的关节索引，用于张指数与并拢度。 */
const FINGER_DEFS = Object.freeze([
  Object.freeze([5, 6, 8]),
  Object.freeze([9, 10, 12]),
  Object.freeze([13, 14, 16]),
  Object.freeze([17, 18, 20]),
]);

/** 手势枚举（state.gesture）。 */
const GESTURES = Object.freeze([
  'idle',
  'open',
  'together',
  'pinch',
  'fist',
  'point',
  'wave',
]);

/** 兜底默认值；CONFIG.hand 缺失时使用。 */
const DEFAULTS = Object.freeze({
  smoothing: Object.freeze({ palm: 0.14, openness: 0.18, motion: 0.35 }),
  pinch: Object.freeze({ startRatio: 0.24, releaseRatio: 0.4, fallback: 0.16 }),
  wave: Object.freeze({
    windowMs: 260,
    minDx: 0.16,
    maxDy: 0.12,
    minOpenness: 0.62,
    minSpeed: 0.5,
    cooldownMs: 1150,
    settleMs: 180,
    holdMs: 400,
  }),
});

// ===========================================================================
// 小工具
// ===========================================================================

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function positiveOr(value, fallback) {
  return isFiniteNumber(value) && value > 0 ? value : fallback;
}

function numberOr(value, fallback) {
  return isFiniteNumber(value) ? value : fallback;
}

function objectOrNull(value) {
  return value && typeof value === 'object' ? value : null;
}

/** 每个顶点统一成完整 3D 点；x/y 必须有限，z 缺失按 0 处理。 */
function readLandmark(landmarks, index) {
  const raw = landmarks[index];
  if (!raw || typeof raw !== 'object') return null;
  if (!isFiniteNumber(raw.x) || !isFiniteNumber(raw.y)) return null;
  return { x: raw.x, y: raw.y, z: isFiniteNumber(raw.z) ? raw.z : 0 };
}

/** 宽高比校正空间里的点（X = x·aspect，Y = y，Z = z·aspect）。 */
function correctedPoint(point, aspect) {
  return { x: point.x * aspect, y: point.y, z: point.z * aspect };
}

function distance3(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function clampCoord(value) {
  return clamp01(value);
}

function makeNode(id, label, x, y, z, kind) {
  return {
    id,
    label,
    x: clampCoord(x),
    y: clampCoord(y),
    z: isFiniteNumber(z) ? z : 0,
    kind,
  };
}

/** 捏合比分母下限（手掌尺度退化 / 手太远时仍保持可比）。 */
const PINCH_SCALE_FALLBACK = positiveOr(
  CONFIG && CONFIG.hand && CONFIG.hand.zoom && CONFIG.hand.zoom.spanFallback,
  DEFAULTS.pinch.fallback,
);

// ===========================================================================
// deriveHandNodes
// ===========================================================================

/**
 * 从 21 个 landmark 推导出基础 + 衍生节点和手势几何量。
 *
 * @param {Array<{x:number,y:number,z?:number}>} landmarks MediaPipe normalized 21 点。
 * @param {number} [aspect=1] videoWidth / videoHeight。
 * @returns {{
 *   nodes: Array<{id:string,label:string,x:number,y:number,z:number,kind:'base'|'derived'}>,
 *   palmCenter: {x:number,y:number,z:number},
 *   palmScale: number,
 *   pinchRatio: number,
 *   openness: number,
 *   normal: {x:number,y:number,z:number},
 * } | null} 输入不是可用的手时返回 null（绝不抛错）。
 */
export function deriveHandNodes(landmarks, aspect) {
  try {
    return deriveHandNodesInternal(landmarks, aspect);
  } catch {
    // 防御性兜底：任何结构异常都不应该让渲染 / 手势循环崩溃。
    return null;
  }
}

function deriveHandNodesInternal(landmarks, aspect) {
  if (!landmarks || typeof landmarks !== 'object') return null;
  const length = landmarks.length;
  if (!isFiniteNumber(length) || length < LANDMARK_COUNT) return null;

  const safeAspect = isFiniteNumber(aspect) && aspect > 0 ? aspect : 1;

  const raw = new Array(LANDMARK_COUNT);
  let validCount = 0;
  for (let index = 0; index < LANDMARK_COUNT; index += 1) {
    const point = readLandmark(landmarks, index);
    raw[index] = point;
    if (point) validCount += 1;
  }
  if (validCount < MIN_VALID_LANDMARKS) return null;
  for (const index of REQUIRED_INDICES) {
    if (!raw[index]) return null;
  }

  const corrected = new Array(LANDMARK_COUNT);
  for (let index = 0; index < LANDMARK_COUNT; index += 1) {
    corrected[index] = raw[index] ? correctedPoint(raw[index], safeAspect) : null;
  }

  // —— 掌心：0/5/9/13/17 均值 ——
  let centerX = 0;
  let centerY = 0;
  let centerZ = 0;
  for (const index of PALM_INDICES) {
    centerX += raw[index].x;
    centerY += raw[index].y;
    centerZ += raw[index].z;
  }
  centerX /= PALM_INDICES.length;
  centerY /= PALM_INDICES.length;
  centerZ /= PALM_INDICES.length;
  const palmCenter = { x: centerX, y: centerY, z: centerZ };

  // —— 手掌尺度：wrist(0) ↔ middleMCP(9)，退化为 5 ↔ 17 ——
  const wristToMiddle = distance3(corrected[WRIST], corrected[MIDDLE_MCP]);
  const knuckleSpan = distance3(corrected[INDEX_MCP], corrected[PINKY_MCP]);
  const palmScale = wristToMiddle > EPSILON ? wristToMiddle : knuckleSpan > EPSILON ? knuckleSpan : 0;

  // —— 捏合比：指尖 4 ↔ 8 / max(palmScale, fallback) ——
  const pinchDistance = distance3(corrected[THUMB_TIP], corrected[INDEX_TIP]);
  const pinchDenominator = Math.max(palmScale, PINCH_SCALE_FALLBACK);
  let pinchRatio = pinchDenominator > EPSILON ? pinchDistance / pinchDenominator : 1;
  if (!isFiniteNumber(pinchRatio) || pinchRatio < 0) pinchRatio = 1;

  // —— 张合度：复用根目录 tension.js 的标定模型 ——
  const rawOpenness = computeTension(landmarks, safeAspect);
  const openness = isFiniteNumber(rawOpenness) ? clamp01(rawOpenness) : 0;

  // —— 四指伸展 / 并拢度 / 食指指向 ——
  const centerCorrected = correctedPoint(palmCenter, safeAspect);
  const fingers = FINGER_DEFS.map(([mcp, pip, tip]) => {
    if (!corrected[mcp] || !corrected[pip] || !corrected[tip]) return false;
    const tipToWrist = distance3(corrected[tip], corrected[WRIST]);
    const pipToWrist = distance3(corrected[pip], corrected[WRIST]);
    const tipToMcp = distance3(corrected[tip], corrected[mcp]);
    const pipToMcp = distance3(corrected[pip], corrected[mcp]);
    if (!(pipToWrist > EPSILON) || !(pipToMcp > EPSILON)) return false;
    return tipToWrist > pipToWrist * 1.08 && tipToMcp > pipToMcp * 1.04;
  });
  const fingerCount = fingers.reduce((sum, extended) => sum + (extended ? 1 : 0), 0);
  const indexToPinky = corrected[INDEX_TIP] && corrected[20]
    ? distance3(corrected[INDEX_TIP], corrected[20]) / Math.max(palmScale, EPSILON)
    : 0;
  const spread = clamp01((indexToPinky - 0.42) / 0.5);
  const flatHand = fingerCount === 4 && indexToPinky >= 0.72 && openness > 0.5;
  const together = fingerCount === 4 && indexToPinky < 0.72 && openness > 0.5;
  const fist = fingerCount === 0 && openness < 0.58;
  const point = fingerCount === 1 && fingers[0] && pinchRatio >= 0.3;

  // 掌幅方向：手腕 → 中指根。
  const spanDirection = normalizeScreenDirection(corrected[WRIST], corrected[MIDDLE_MCP]);
  const spanLength = palmScale * 0.45;
  const spanEndCorrected = {
    x: centerCorrected.x + spanDirection.x * spanLength,
    y: centerCorrected.y + spanDirection.y * spanLength,
  };

  // 校正空间 → 归一化空间：x = X / aspect，y = Y（镜像只影响 x 的显示符号）。
  const spanEnd = { x: spanEndCorrected.x / safeAspect, y: spanEndCorrected.y };
  const pinchMidRaw = {
    x: (raw[THUMB_TIP].x + raw[INDEX_TIP].x) / 2,
    y: (raw[THUMB_TIP].y + raw[INDEX_TIP].y) / 2,
    z: (raw[THUMB_TIP].z + raw[INDEX_TIP].z) / 2,
  };

  // —— 组装 21 个基础节点（镜像 + clamp 0..1）——
  const nodes = new Array(LANDMARK_COUNT + DERIVED_NODE_IDS.length);
  for (let index = 0; index < LANDMARK_COUNT; index += 1) {
    const [id, label] = BASE_NODE_DEFS[index];
    const point = raw[index];
    // 个别点缺失（被遮挡）时退回到掌心位置，保持节点数组稳定。
    const x = 1 - (point ? point.x : palmCenter.x);
    const y = point ? point.y : palmCenter.y;
    const z = point ? point.z : 0;
    nodes[index] = makeNode(id, label, x, y, z, 'base');
  }

  // —— 5 个衍生节点（顺序 = DERIVED_NODE_IDS）——
  const derivedPoints = [
    [palmCenter.x, palmCenter.y, palmCenter.z],
    [pinchMidRaw.x, pinchMidRaw.y, pinchMidRaw.z],
    [raw[INDEX_TIP].x, raw[INDEX_TIP].y, raw[INDEX_TIP].z],
    [raw[THUMB_TIP].x, raw[THUMB_TIP].y, raw[THUMB_TIP].z],
    [spanEnd.x, spanEnd.y, palmCenter.z],
  ];
  for (let offset = 0; offset < DERIVED_NODE_IDS.length; offset += 1) {
    const id = DERIVED_NODE_IDS[offset];
    const [x, y, z] = derivedPoints[offset];
    nodes[LANDMARK_COUNT + offset] = makeNode(id, DERIVED_NODE_LABELS[id], 1 - x, y, z, 'derived');
  }

  return {
    nodes,
    palmCenter: {
      x: clampCoord(1 - palmCenter.x),
      y: clampCoord(palmCenter.y),
      z: palmCenter.z,
    },
    palmScale,
    palmSpan: palmScale,
    pinchRatio,
    openness,
    fingerCount,
    fingers,
    spread,
    flat: flatHand,
    together,
    fist,
    point,
  };
}

/** 屏幕（校正空间）方向：from → to，归一化；退化时朝上（0,-1）。 */
function normalizeScreenDirection(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  if (!(length > EPSILON)) return { x: 0, y: -1 };
  return { x: dx / length, y: dy / length };
}

// ===========================================================================
// 状态默认值
// ===========================================================================

/** 无手 / 重置时的安全 state（每次返回新对象，调用方可以放心持有）。 */
function createLostState(timestampMs) {
  return {
    visible: false,
    timestampMs: isFiniteNumber(timestampMs) ? timestampMs : 0,
    palm: { x: 0.5, y: 0.5, z: 0 },
    palmScale: 0,
    openness: 0,
    fingerCount: 0,
    fingers: [false, false, false, false],
    spread: 0,
    flat: false,
    together: false,
    fist: false,
    point: false,
    palmSpan: 0,
    indexTip: null,
    pinch: { active: false, ratio: 1, strength: 0, midpoint: { x: 0.5, y: 0.5 } },
    pinchStarted: false,
    pinchReleased: false,
    wave: null,
    gesture: 'idle',
    motion: { vx: 0, vy: 0, speed: 0 },
    nodes: [],
  };
}

function copyWave(wave) {
  if (!wave) return null;
  return {
    direction: wave.direction,
    strength: wave.strength,
    distance: wave.distance,
    speed: wave.speed,
  };
}

// ===========================================================================
// 选项合并
// ===========================================================================

function resolveOptions(options) {
  const input = objectOrNull(options) || {};
  const hand = objectOrNull(CONFIG && CONFIG.hand) || {};
  const configSmoothing = objectOrNull(hand.smoothing) || {};
  const configPinch = objectOrNull(hand.pinch) || {};
  const configWave = objectOrNull(hand.wave) || {};
  const configZoom = objectOrNull(hand.zoom) || {};
  const inputSmoothing = objectOrNull(input.smoothing) || {};
  const inputPinch = objectOrNull(input.pinch) || {};
  const inputWave = objectOrNull(input.wave) || {};

  const smoothing = {
    palm: clamp01(
      numberOr(inputSmoothing.palm, numberOr(configSmoothing.palm, DEFAULTS.smoothing.palm)),
    ),
    openness: clamp01(
      numberOr(inputSmoothing.openness, numberOr(configSmoothing.openness, DEFAULTS.smoothing.openness)),
    ),
    motion: clamp01(
      numberOr(inputSmoothing.motion, numberOr(configSmoothing.motion, DEFAULTS.smoothing.motion)),
    ),
  };
  // alpha = 0 等价于不更新，允许但没意义；给一个可见下限，避免 Lead 误传 0 后画面冻结。
  if (smoothing.palm <= 0) smoothing.palm = DEFAULTS.smoothing.palm;
  if (smoothing.openness <= 0) smoothing.openness = DEFAULTS.smoothing.openness;

  let startRatio = positiveOr(
    numberOr(inputPinch.startRatio, numberOr(configPinch.startRatio, DEFAULTS.pinch.startRatio)),
    DEFAULTS.pinch.startRatio,
  );
  let releaseRatio = positiveOr(
    numberOr(inputPinch.releaseRatio, numberOr(configPinch.releaseRatio, DEFAULTS.pinch.releaseRatio)),
    DEFAULTS.pinch.releaseRatio,
  );
  if (!(releaseRatio > startRatio)) {
    startRatio = DEFAULTS.pinch.startRatio;
    releaseRatio = DEFAULTS.pinch.releaseRatio;
  }
  const confirmFramesRaw = numberOr(inputPinch.confirmFrames, 2);
  const pinch = {
    startRatio,
    releaseRatio,
    confirmFrames: Math.max(1, Math.min(10, Math.round(confirmFramesRaw))),
    scaleFallback: positiveOr(
      numberOr(inputPinch.scaleFallback, numberOr(configZoom.spanFallback, DEFAULTS.pinch.fallback)),
      DEFAULTS.pinch.fallback,
    ),
  };

  const wave = {
    windowMs: positiveOr(
      numberOr(inputWave.windowMs, numberOr(configWave.windowMs, DEFAULTS.wave.windowMs)),
      DEFAULTS.wave.windowMs,
    ),
    minDx: positiveOr(
      numberOr(inputWave.minDx, numberOr(configWave.minDx, DEFAULTS.wave.minDx)),
      DEFAULTS.wave.minDx,
    ),
    maxDy: positiveOr(
      numberOr(inputWave.maxDy, numberOr(configWave.maxDy, DEFAULTS.wave.maxDy)),
      DEFAULTS.wave.maxDy,
    ),
    minOpenness: clamp01(
      numberOr(inputWave.minOpenness, numberOr(configWave.minOpenness, DEFAULTS.wave.minOpenness)),
    ),
    minSpeed: positiveOr(
      numberOr(inputWave.minSpeed, numberOr(configWave.minSpeed, DEFAULTS.wave.minSpeed)),
      DEFAULTS.wave.minSpeed,
    ),
    cooldownMs: positiveOr(
      numberOr(inputWave.cooldownMs, numberOr(configWave.cooldownMs, DEFAULTS.wave.cooldownMs)),
      DEFAULTS.wave.cooldownMs,
    ),
    settleMs: positiveOr(
      numberOr(inputWave.settleMs, numberOr(configWave.settleMs, DEFAULTS.wave.settleMs)),
      DEFAULTS.wave.settleMs,
    ),
    holdMs: positiveOr(
      numberOr(inputWave.holdMs, numberOr(configWave.holdMs, DEFAULTS.wave.holdMs)),
      DEFAULTS.wave.holdMs,
    ),
  };

  return { smoothing, pinch, wave };
}

// ===========================================================================
// HandController
// ===========================================================================

/**
 * 手部手势状态机。
 *
 * 用法：
 *   const controller = new HandController();
 *   // 每一帧（onFrame）里：
 *   const state = controller.update(frame.landmarks, frame.aspect, frame.timestampMs);
 *   // state === null 表示这一帧没有手；有手时返回完整 state（见 CONTRACT 第 4 节）。
 *   overlay.update({ landmarks: frame.landmarks, ...frame, state });
 */
export class HandController {
  #options;
  #state;
  #detection = null;

  // 平滑值
  #palm = null;
  #openness = 0;

  // 上一帧原始掌心 / 时间，用于速度与「停稳」判断
  #prevRawPalm = null;
  #prevFrameAt = null;
  #motion = { vx: 0, vy: 0, speed: 0 };

  // 捏合
  #pinchActive = false;
  #pinchStartFrames = 0;
  #pinchReleaseFrames = 0;

  // 挥手
  #samples = [];
  #armed = true;
  #waveCooldownUntil = null;
  #lastMotionAt = null;
  #lastWave = null;
  #waveUntil = -Infinity;

  #lastTimestamp = null;

  /**
   * @param {object} [options]
   * @param {object} [options.smoothing] 覆盖 EMA alpha：{ palm, openness, motion }。
   * @param {object} [options.pinch] 覆盖捏合参数：{ startRatio, releaseRatio, confirmFrames }。
   * @param {object} [options.wave] 覆盖挥手参数：{ windowMs, minDx, maxDy, minOpenness,
   *                               minSpeed, cooldownMs, settleMs, holdMs }。
   *        不传时读取 `CONFIG.hand`；两者都缺失时使用契约里的默认阈值。
   */
  constructor(options = {}) {
    this.#options = resolveOptions(options);
    this.#state = createLostState(0);
  }

  /** 最近一帧的 state；从未检测到手时返回安全默认值（visible:false）。 */
  get state() {
    return this.#state;
  }

  /** 当前生效的（已合并 CONFIG + 构造参数的）阈值，主要给调试 / 测试用。 */
  get options() {
    return this.#options;
  }

  /**
   * 喂一帧手部数据。
   *
   * @param {Array<{x:number,y:number,z?:number}>|null} landmarks 21 点；无手传 null。
   * @param {number} [aspect] videoWidth / videoHeight；非法时按 1 处理。
   * @param {number} [timestampMs] 单调递增的检测时间（毫秒）；非法时按上一帧 + 16.7ms。
   * @returns {object|null} 有手时返回 state，无手 / 非法输入时返回 null（并 reset）。
   */
  update(landmarks, aspect, timestampMs) {
    const now = this.#resolveTimestamp(timestampMs);

    let detection = null;
    try {
      detection = deriveHandNodes(landmarks, aspect);
    } catch {
      detection = null;
    }

    if (!detection) {
      this.#resetInternal();
      this.#state = createLostState(now);
      return null;
    }

    this.#detection = detection;

    const rawPalm = detection.palmCenter;
    const frameDt = this.#prevFrameAt === null ? 0 : Math.max(0, now - this.#prevFrameAt);
    const dtSeconds = frameDt / 1000;

    // —— 平滑：掌心 0.14，openness 0.18（首帧直接吸附，避免从 (0.5,0.5) 慢慢爬）——
    const palmAlpha = this.#options.smoothing.palm;
    if (!this.#palm) {
      this.#palm = { x: rawPalm.x, y: rawPalm.y, z: rawPalm.z };
      this.#openness = detection.openness;
    } else {
      this.#palm = {
        x: this.#palm.x + (rawPalm.x - this.#palm.x) * palmAlpha,
        y: this.#palm.y + (rawPalm.y - this.#palm.y) * palmAlpha,
        z: this.#palm.z + (rawPalm.z - this.#palm.z) * palmAlpha,
      };
      this.#openness += (detection.openness - this.#openness) * this.#options.smoothing.openness;
    }
    const openness = clamp01(this.#openness);

    // —— 逐帧运动速度（原始掌心，用于 state.motion / 停稳判断）——
    let instantVx = 0;
    let instantVy = 0;
    if (this.#prevRawPalm && dtSeconds > 1e-4) {
      instantVx = (rawPalm.x - this.#prevRawPalm.x) / dtSeconds;
      instantVy = (rawPalm.y - this.#prevRawPalm.y) / dtSeconds;
    }
    const motionAlpha = this.#prevFrameAt === null ? 1 : this.#options.smoothing.motion;
    this.#motion = {
      vx: this.#motion.vx + (instantVx - this.#motion.vx) * motionAlpha,
      vy: this.#motion.vy + (instantVy - this.#motion.vy) * motionAlpha,
    };
    this.#motion.speed = Math.sqrt(this.#motion.vx * this.#motion.vx + this.#motion.vy * this.#motion.vy);

    // —— 停稳 / re-arm 跟踪 + 挥手样本历史 ——
    const step = this.#prevRawPalm
      ? Math.sqrt(
          (rawPalm.x - this.#prevRawPalm.x) * (rawPalm.x - this.#prevRawPalm.x) +
            (rawPalm.y - this.#prevRawPalm.y) * (rawPalm.y - this.#prevRawPalm.y),
        )
      : 0;
    const stepSpeed = dtSeconds > 1e-4 ? step / dtSeconds : 0;
    if (this.#lastMotionAt === null || stepSpeed > 0.08) {
      this.#lastMotionAt = now;
    }

    this.#pushSample(now, rawPalm.x, rawPalm.y);
    this.#maybeRearm(now);

    // —— 捏合（滞回 + 连续 2 帧确认；触摸前先更新，保证同帧生效）——
    const pinchTransition = this.#updatePinch(detection.pinchRatio);

    // —— 挥手（方向 / 冷却 / re-arm）——
    this.#detectWave(now, rawPalm, openness);

    this.#prevRawPalm = { x: rawPalm.x, y: rawPalm.y, z: rawPalm.z };
    this.#prevFrameAt = now;

    const wave = now <= this.#waveUntil ? copyWave(this.#lastWave) : null;
    const pinchActive = this.#pinchActive;
    let gesture = 'idle';
    if (wave) gesture = 'wave';
    else if (pinchActive) gesture = 'pinch';
    else if (detection.fist) gesture = 'fist';
    else if (detection.point) gesture = 'point';
    else if (detection.together) gesture = 'together';
    else if (detection.flat) gesture = 'open';

    const pinchNode = findDerivedNode(detection.nodes, 'pinchMid');
    const indexNode = findDerivedNode(detection.nodes, 'indexTip');
    const pinchStrength = computePinchStrength(detection.pinchRatio, this.#options.pinch);

    this.#state = {
      visible: true,
      timestampMs: now,
      palm: { x: clamp01(this.#palm.x), y: clamp01(this.#palm.y), z: this.#palm.z },
      palmScale: detection.palmScale,
      openness,
      fingerCount: detection.fingerCount,
      fingers: detection.fingers,
      spread: detection.spread,
      flat: detection.flat,
      together: detection.together,
      fist: detection.fist,
      point: detection.point,
      palmSpan: detection.palmScale,
      indexTip: indexNode ? { x: indexNode.x, y: indexNode.y, z: indexNode.z } : null,
      pinch: {
        active: pinchActive,
        ratio: isFiniteNumber(detection.pinchRatio) ? detection.pinchRatio : 1,
        strength: pinchStrength,
        midpoint: pinchNode
          ? { x: pinchNode.x, y: pinchNode.y }
          : { x: clamp01(1 - rawPalm.x), y: clamp01(rawPalm.y) },
      },
      pinchStarted: pinchTransition.started,
      pinchReleased: pinchTransition.released,
      wave,
      gesture,
      motion: {
        vx: isFiniteNumber(this.#motion.vx) ? this.#motion.vx : 0,
        vy: isFiniteNumber(this.#motion.vy) ? this.#motion.vy : 0,
        speed: isFiniteNumber(this.#motion.speed) ? this.#motion.speed : 0,
      },
      nodes: detection.nodes,
    };

    return this.#state;
  }

  /**
   * 清空全部时序状态（挥手历史 / 冷却 / 捏合 / 平滑）。手丢失时内部自动调用。
   * 保留最后时间戳，避免画面里的手势计时突然回到 0。
   */
  reset() {
    this.#resetInternal();
    this.#state = createLostState(this.#lastTimestamp);
  }

  // -------------------------------------------------------------------------
  // 内部实现
  // -------------------------------------------------------------------------

  #resetInternal() {
    this.#detection = null;
    this.#palm = null;
    this.#openness = 0;
    this.#prevRawPalm = null;
    this.#prevFrameAt = null;
    this.#motion = { vx: 0, vy: 0, speed: 0 };
    this.#pinchActive = false;
    this.#pinchStartFrames = 0;
    this.#pinchReleaseFrames = 0;
    this.#samples = [];
    this.#armed = true;
    this.#waveCooldownUntil = null;
    this.#lastMotionAt = null;
    this.#lastWave = null;
    this.#waveUntil = -Infinity;
  }

  /** 时间戳归一化：保证严格单调递增，非法值用上一帧 + 一帧时长兜底。 */
  #resolveTimestamp(timestampMs) {
    let now;
    if (isFiniteNumber(timestampMs)) {
      now =
        this.#lastTimestamp !== null && timestampMs <= this.#lastTimestamp
          ? this.#lastTimestamp + MIN_FRAME_MS
          : timestampMs;
    } else {
      now = this.#lastTimestamp === null ? 0 : this.#lastTimestamp + DEFAULT_FRAME_MS;
    }
    this.#lastTimestamp = now;
    return now;
  }

  #pushSample(now, x, y) {
    this.#samples.push({ t: now, x, y });
    // 只保留窗口 + 余量内的样本，避免长时间运行时数组膨胀。
    const maxAge = this.#options.wave.windowMs + 400;
    let firstKept = 0;
    while (firstKept < this.#samples.length && this.#samples[firstKept].t < now - maxAge) {
      firstKept += 1;
    }
    if (firstKept > 0) this.#samples.splice(0, firstKept);
    if (this.#samples.length > 240) this.#samples.splice(0, this.#samples.length - 240);
  }

  /**
   * 挥手后重新 arm：
   *   - 冷却（cooldownMs）结束；
   *   - 手已经停稳（settleMs）——「停稳」= 连续至少 settleMs 没有明显的逐帧位移，
   *     避免用户持续甩手时每帧都触发。
   */
  #maybeRearm(now) {
    if (this.#armed) return;
    const { cooldownMs, settleMs } = this.#options.wave;
    if (this.#waveCooldownUntil !== null && now < this.#waveCooldownUntil) return;
    const lastMotion = this.#lastMotionAt ?? -Infinity;
    if (now - lastMotion >= settleMs) {
      this.#armed = true;
    }
  }

  /**
   * 用最近 windowMs 的掌心位移判断左右挥手。方向：x 增大 = next，x 减小 = prev。
   * 触发一次后立刻进入冷却并解除 arm（见 #maybeRearm）。
   */
  #detectWave(now, rawPalm, openness) {
    if (!this.#armed) return;
    const { windowMs, minDx, maxDy, minOpenness, minSpeed, cooldownMs, holdMs } = this.#options.wave;

    const reference = this.#findReferenceSample(now - windowMs);
    if (!reference) return;
    const spanMs = now - reference.t;
    if (!(spanMs >= windowMs)) return;

    const dx = rawPalm.x - reference.x;
    const dy = rawPalm.y - reference.y;
    const spanSeconds = spanMs / 1000;
    const speed = spanSeconds > 0 ? Math.abs(dx) / spanSeconds : 0;

    if (!(Math.abs(dx) > minDx)) return;
    if (!(Math.abs(dy) < maxDy)) return;
    if (!(openness > minOpenness)) return;
    if (!(speed > minSpeed)) return;

    const direction = dx > 0 ? 'next' : 'prev';
    this.#lastWave = {
      direction,
      strength: clamp01(Math.abs(dx) / (minDx * 2)),
      distance: Math.abs(dx),
      speed,
    };
    this.#waveUntil = now + holdMs;
    this.#waveCooldownUntil = now + cooldownMs;
    this.#lastMotionAt = now;
    this.#armed = false;
  }

  /** 找到时间戳 <= target 的最新样本；没有足够旧的历史时返回 null。 */
  #findReferenceSample(target) {
    const samples = this.#samples;
    let reference = null;
    for (let index = samples.length - 1; index >= 0; index -= 1) {
      if (samples[index].t <= target) {
        reference = samples[index];
        break;
      }
    }
    return reference;
  }

  /** 捏合状态机：< startRatio 连续 confirmFrames 帧开始，> releaseRatio 连续确认释放。 */
  #updatePinch(ratio) {
    const { startRatio, releaseRatio, confirmFrames } = this.#options.pinch;
    let started = false;
    let released = false;
    const valid = isFiniteNumber(ratio);

    if (!this.#pinchActive) {
      if (valid && ratio < startRatio) this.#pinchStartFrames += 1;
      else this.#pinchStartFrames = 0;
      if (this.#pinchStartFrames >= confirmFrames) {
        this.#pinchActive = true;
        this.#pinchStartFrames = 0;
        this.#pinchReleaseFrames = 0;
        started = true;
      }
    } else {
      if (valid && ratio > releaseRatio) this.#pinchReleaseFrames += 1;
      else this.#pinchReleaseFrames = 0;
      if (this.#pinchReleaseFrames >= confirmFrames) {
        this.#pinchActive = false;
        this.#pinchReleaseFrames = 0;
        this.#pinchStartFrames = 0;
        released = true;
      }
    }

    return { started, released };
  }
}

/** 从 nodes 里找某个衍生节点。 */
function findDerivedNode(nodes, id) {
  if (!Array.isArray(nodes)) return null;
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (node && node.id === id) return node;
  }
  return null;
}

/** 捏合强度：ratio 从 releaseRatio → startRatio 线性升到 1。 */
function computePinchStrength(ratio, pinchOptions) {
  if (!isFiniteNumber(ratio)) return 0;
  const { startRatio, releaseRatio } = pinchOptions;
  const range = releaseRatio - startRatio;
  if (!(range > 0)) return ratio < startRatio ? 1 : 0;
  return clamp01((releaseRatio - ratio) / range);
}

/** 供 UI / 调试使用的只读手势枚举。 */
export const HAND_GESTURES = GESTURES;
