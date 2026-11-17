/**
 * 指尖生花 / Fingertip Bloom
 * src/tension.js — 手部张力（张合度）数学。
 *
 * 纯函数模块：不触碰 DOM / window，可在 Node 中直接单元测试。
 *
 * ============================================================================
 * 输入 / Input
 * ============================================================================
 * MediaPipe Hand Landmarker 的 21 个 normalized landmarks：
 *   x, y ∈ [0, 1]，原点在画面左上，y 轴向下；z 约与 x 同尺度（负值朝向镜头）。
 * aspect = videoWidth / videoHeight，用于把归一化坐标还原成「等距」坐标：
 *   X = x · aspect，Y = y，Z = z · aspect  （等价于以画面高度为单位）。
 * 若某个 landmark 缺少 z（旧数据 / 单测输入），z 视为 0 —— 此时公式自动退化为
 * 纯 2D 版本，仍然可用（标定见 tests/tension.test.mjs）。
 * z 只在计算「手与世界」的相对几何时使用，因此手势在画面里的平移、缩放、
 * 旋转（含手掌朝镜头倾斜）都不会影响结果。
 *
 * ============================================================================
 * 公式 / Formula（tension ∈ [0, 1]，0 = 握拳，1 = 张开）
 * ============================================================================
 * 1. 手掌尺度：palmScale = |wrist - middleMCP(9)|
 * 2. 四指伸展比：r = |wrist - tip| / |wrist - mcp|（拇指以外）
 *    握拳时 r ≈ 0.45，张开时 r ≈ 1.85（3D 距离）；
 *    ext = clamp((r - 0.62) / (1.58 - 0.62), 0, 1)
 * 3. PIP 伸直度：straight = clamp(cos∠((pip-mcp), (tip-pip)), 0, 1)
 *    完全伸直 = 1，折成 V 形 → 0。
 * 4. 每指得分 = 0.62 · ext + 0.38 · straight
 *    四指权重：食指 0.27 / 中指 0.28 / 无名指 0.25 / 小指 0.20；
 *    个别手指缺数据时跳过并把剩余权重归一化（部分遮挡时仍然稳定）。
 * 5. 拇指（辅助）：thumbScore
 *      = 0.55 · clamp((|wrist - thumbTip| / palmScale - 0.52) / 0.26, 0, 1)
 *      + 0.45 · clamp(cos∠((thumbIP-thumbMCP), (thumbTip-thumbIP)), 0, 1)
 * 6. tension = clamp(0.90 · 四指加权平均 + 0.10 · 拇指得分, 0, 1)
 *
 * 手是刚性尺度不变的，上述全是比值 / 夹角，因此对镜头远近（scale）、
 * 画面内旋转（rotation）与手掌倾斜（palm tilt）都鲁棒；输入不合法时返回 0。
 *
 * ============================================================================
 * 阈值 / Thresholds（统一从 CONFIG.tension 读取，避免重复硬编码）
 * ============================================================================
 *   tension < closed (CONFIG, 0.48)     → 'bud'       花苞（握拳）
 *   closed ≤ tension < open (CONFIG, 0.88) → 'unfolding' 半绽
 *   tension ≥ open                     → 'bloom'     盛放（完全张开）
 *   tensionToSpread 在 closed..open 之间做 smoothstep：0 → 1
 */

import { CONFIG } from './config.js';

const clamp01 = (value) => (value < 0 ? 0 : value > 1 ? 1 : value);
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const normalize = (value, min, max) => clamp01((value - min) / (max - min));

/**
 * 把未知的张力输入归一化为 0..1：
 * 数字且非 NaN 的输入会被 clamp（±Infinity 自然落到 0 / 1），其余一律当作 0。
 * 这样 tensionToSpread / classifyGesture 对脏数据也保持单调、不抛错。
 */
const asTension = (tension) =>
  typeof tension === 'number' && !Number.isNaN(tension) ? clamp01(tension) : 0;

/** MediaPipe Hands 的 21 个 landmark 索引。 */
export const LANDMARKS = Object.freeze({
  WRIST: 0,
  THUMB_CMC: 1,
  THUMB_MCP: 2,
  THUMB_IP: 3,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_PIP: 6,
  INDEX_DIP: 7,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_PIP: 10,
  MIDDLE_DIP: 11,
  MIDDLE_TIP: 12,
  RING_MCP: 13,
  RING_PIP: 14,
  RING_DIP: 15,
  RING_TIP: 16,
  PINKY_MCP: 17,
  PINKY_PIP: 18,
  PINKY_DIP: 19,
  PINKY_TIP: 20,
});

/**
 * 公式常量（与文件顶部注释一一对应）。
 * 这些值由合成的 21 点手部模型标定，改这里会同时影响四指与拇指的灵敏度。
 */
const MODEL = Object.freeze({
  /** 四指「手腕→指尖 / 手腕→MCP」伸展比的有效区间。 */
  extensionMin: 0.62,
  extensionMax: 1.58,
  /** 每指得分中伸展比与 PIP 伸直度的权重。 */
  extensionWeight: 0.62,
  straightnessWeight: 0.38,
  /** 四指总权重 / 拇指权重。 */
  fingersWeight: 0.9,
  thumbWeight: 0.1,
  /** 拇指伸展比（除以 palmScale）的有效区间。 */
  thumbExtensionMin: 0.52,
  thumbExtensionMax: 0.78,
  /** 拇指得分中伸展比与 IP 伸直度的权重。 */
  thumbExtensionWeight: 0.55,
  thumbStraightnessWeight: 0.45,
  /** 距离 / 长度的数值下限，低于它视为退化输入。 */
  epsilon: 1e-6,
  palmEpsilon: 1e-5,
});

/**
 * 四指（不含拇指）：MCP、PIP、TIP 三个点 + 权重。
 * 权重略偏向食指 / 中指：它们最常被使用，也更少被手掌遮挡。
 */
const FINGERS = Object.freeze([
  Object.freeze({ mcp: LANDMARKS.INDEX_MCP, pip: LANDMARKS.INDEX_PIP, tip: LANDMARKS.INDEX_TIP, weight: 0.27 }),
  Object.freeze({ mcp: LANDMARKS.MIDDLE_MCP, pip: LANDMARKS.MIDDLE_PIP, tip: LANDMARKS.MIDDLE_TIP, weight: 0.28 }),
  Object.freeze({ mcp: LANDMARKS.RING_MCP, pip: LANDMARKS.RING_PIP, tip: LANDMARKS.RING_TIP, weight: 0.25 }),
  Object.freeze({ mcp: LANDMARKS.PINKY_MCP, pip: LANDMARKS.PINKY_PIP, tip: LANDMARKS.PINKY_TIP, weight: 0.2 }),
]);

/** 读取一个 landmark，做 aspect 修正并补齐 3D 坐标；无效时返回 null。 */
function readPoint(landmarks, index, aspect) {
  const raw = landmarks[index];
  if (!raw || typeof raw !== 'object') return null;
  const { x, y } = raw;
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
  const z = isFiniteNumber(raw.z) ? raw.z : 0;
  return { x: x * aspect, y, z: z * aspect };
}

/** 3D 欧氏距离（点均为 {x, y, z}）。 */
function distance3(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * 关节伸直度：向量 (b - a) 与 (c - b) 夹角的余弦，clamp 到 0..1。
 * 完全伸直 ≈ 1；折叠超过 90° 时为 0（夹角的余弦为负）。
 */
function jointStraightness(a, b, c) {
  const x1 = b.x - a.x;
  const y1 = b.y - a.y;
  const z1 = b.z - a.z;
  const x2 = c.x - b.x;
  const y2 = c.y - b.y;
  const z2 = c.z - b.z;
  const length1 = Math.sqrt(x1 * x1 + y1 * y1 + z1 * z1);
  const length2 = Math.sqrt(x2 * x2 + y2 * y2 + z2 * z2);
  if (!(length1 > MODEL.epsilon) || !(length2 > MODEL.epsilon)) return 0;
  const cosine = (x1 * x2 + y1 * y2 + z1 * z2) / (length1 * length2);
  return clamp01(cosine);
}

/**
 * 张力核心计算（调用前已保证 landmarks 是对象）。
 * 任何一步出现退化数据都返回 0，绝不抛错。
 */
function evaluateTension(landmarks, aspect) {
  const length = landmarks.length;
  if (!isFiniteNumber(length) || length < 21) return 0;

  const scaleFactor = isFiniteNumber(aspect) && aspect > 0 ? aspect : 1;
  const wrist = readPoint(landmarks, LANDMARKS.WRIST, scaleFactor);
  if (!wrist) return 0;
  const middleMcp = readPoint(landmarks, LANDMARKS.MIDDLE_MCP, scaleFactor);
  if (!middleMcp) return 0;

  const palmScale = distance3(wrist, middleMcp);
  if (!(palmScale > MODEL.palmEpsilon)) return 0;

  // —— 四指 ——
  let fingerSum = 0;
  let fingerWeight = 0;
  for (const finger of FINGERS) {
    const mcp = readPoint(landmarks, finger.mcp, scaleFactor);
    const pip = readPoint(landmarks, finger.pip, scaleFactor);
    const tip = readPoint(landmarks, finger.tip, scaleFactor);
    // 被遮挡的手指直接跳过，剩余手指权重重归一化。
    if (!mcp || !pip || !tip) continue;

    const wristToMcp = distance3(wrist, mcp);
    if (!(wristToMcp > MODEL.epsilon)) continue;

    const extensionRatio = distance3(wrist, tip) / wristToMcp;
    const extension = normalize(extensionRatio, MODEL.extensionMin, MODEL.extensionMax);
    const straightness = jointStraightness(mcp, pip, tip);
    const score = MODEL.extensionWeight * extension + MODEL.straightnessWeight * straightness;

    fingerSum += finger.weight * score;
    fingerWeight += finger.weight;
  }

  // —— 拇指（辅助信号） ——
  const thumbMcp = readPoint(landmarks, LANDMARKS.THUMB_MCP, scaleFactor);
  const thumbIp = readPoint(landmarks, LANDMARKS.THUMB_IP, scaleFactor);
  const thumbTip = readPoint(landmarks, LANDMARKS.THUMB_TIP, scaleFactor);
  let thumbScore = 0;
  if (thumbMcp && thumbIp && thumbTip) {
    const thumbExtension = normalize(
      distance3(wrist, thumbTip) / palmScale,
      MODEL.thumbExtensionMin,
      MODEL.thumbExtensionMax,
    );
    const thumbStraightness = jointStraightness(thumbMcp, thumbIp, thumbTip);
    thumbScore = MODEL.thumbExtensionWeight * thumbExtension + MODEL.thumbStraightnessWeight * thumbStraightness;
  }

  // 极端遮挡时四指全部缺失，用拇指得分兜底，避免整手冻结在 0。
  const fingers = fingerWeight > 0 ? fingerSum / fingerWeight : thumbScore;
  return clamp01(MODEL.fingersWeight * fingers + MODEL.thumbWeight * thumbScore);
}

/**
 * 计算手部张力（张合度）。
 *
 * @param {Array<{x:number, y:number, z?:number}>} landmarks
 *        MediaPipe 21 点 normalized landmarks。
 * @param {number} [aspect=1] videoWidth / videoHeight。
 * @returns {number} 0（握拳）.. 1（张开）；输入不合法时返回 0，不抛错。
 */
export function computeTension(landmarks, aspect = 1) {
  if (!landmarks || typeof landmarks !== 'object') return 0;
  try {
    return evaluateTension(landmarks, aspect);
  } catch {
    // 防御性兜底：任何结构异常的输入都不应该让渲染循环崩溃。
    return 0;
  }
}

/**
 * 把张力映射为花的开放程度 spread：在 closed..open 之间做 smoothstep。
 * t ≤ closed → 0；t ≥ open → 1；中间为平滑的 S 曲线（无硬拐点）。
 *
 * @param {number} tension
 * @returns {number} 0..1
 */
export function tensionToSpread(tension) {
  const value = asTension(tension);
  const { closed, open } = CONFIG.tension;
  const range = open - closed;
  if (!(range > 0)) return value >= open ? 1 : 0;
  const x = clamp01((value - closed) / range);
  return x * x * (3 - 2 * x); // smoothstep
}

/**
 * 根据张力给出三态手势名，边界与 CONFIG.tension 一致。
 *
 * @param {number} tension
 * @returns {'bud' | 'unfolding' | 'bloom'}
 */
export function classifyGesture(tension) {
  const value = asTension(tension);
  // 与 tensionToSpread 保持一致：spread 恰好为 0 时仍是花苞，达到 1 即盛放。
  if (value <= CONFIG.tension.closed) return 'bud';
  if (value < CONFIG.tension.open) return 'unfolding';
  return 'bloom';
}

/**
 * 由食指指尖（landmark 8）得到屏幕归一化指针坐标。
 * 摄像头画面是镜像显示的，因此 x 也镜像；y 翻转成向上为正，范围约 -1..1。
 *    x = (1 - lm[8].x) · 2 - 1
 *    y = 1 - lm[8].y · 2
 *
 * @param {Array<{x:number, y:number}>} landmarks
 * @returns {{x:number, y:number}} 无效输入返回 { x: 0, y: 0 }。
 */
export function pointerFromLandmarks(landmarks) {
  const tip = landmarks && typeof landmarks === 'object' ? landmarks[LANDMARKS.INDEX_TIP] : null;
  if (!tip || !isFiniteNumber(tip.x) || !isFiniteNumber(tip.y)) return { x: 0, y: 0 };
  return { x: (1 - tip.x) * 2 - 1, y: 1 - tip.y * 2 };
}

/**
 * 纯函数平滑插值：current → target，alpha ∈ 0..1。
 * 渲染循环用 CONFIG.tension.smoothUp / smoothDown 作为 alpha 实现自适应 EMA。
 *
 * @param {number} current
 * @param {number} target
 * @param {number} alpha
 * @returns {number}
 */
export function smoothToward(current, target, alpha) {
  const from = isFiniteNumber(current) ? current : 0;
  const to = isFiniteNumber(target) ? target : from;
  const amount = isFiniteNumber(alpha) ? clamp01(alpha) : 0;
  return from + (to - from) * amount;
}
