/**
 * 太阳系 · 粒子天文台 / Solar System Particle Observatory
 * src/handOverlay.js — 手势骨架的 2D Canvas 叠层（无 three 依赖）。
 *
 * ============================================================================
 * 职责
 * ============================================================================
 * `HandOverlay` 把 `HandTracker` 送的 landmark 和 `HandController` 产出的 state
 * 画在一块覆盖在 WebGL 画布之上的 2D canvas 上，供用户确认「相机看见了我的手」：
 *
 *   - 21 个基础关节：小圆点 + 22 条骨架连线（低透明度，不抢主视觉）；
 *   - 5 个衍生控制点：掌心 / 捏合 / 食指 / 拇指（金色），掌幅（青色），
 *     每个点旁有中文短标签；
 *   - 食指指尖光晕；
 *   - 捏合时高亮拇指尖 ↔ 食指尖连线，并在中点画脉冲环；
 *   - 挥手时在掌心旁短暂显示方向箭头（「⟶」= 下一颗，「⟵」= 上一颗）；
 *   - 无手 / 隐藏时清空画布（不能让上一帧的骨架留在屏幕上）。
 *
 * ============================================================================
 * 与视频背景对齐（object-fit: cover + 自拍镜像）
 * ============================================================================
 * <video> 用 `object-fit: cover` 铺满容器，本 canvas 与它同尺寸叠放，所以映射
 * 公式必须与 cover 完全一致（借鉴根目录 src/handOverlay.js 的已验证实现）：
 *
 *   const scale = Math.max(cssW / videoW, cssH / videoH);
 *   const drawnW = videoW * scale, drawnH = videoH * scale;
 *   const offsetX = (cssW - drawnW) / 2, offsetY = (cssH - drawnH) / 2;
 *   // 自拍镜像：原始 normalized x → 屏幕 px
 *   px = offsetX + (1 - x) * drawnW;
 *   py = offsetY + y * drawnH;
 *
 * DPR 上限 2：canvas 的位图尺寸 = CSS 尺寸 × dpr，绘制前 setTransform(dpr,...)，
 * 保证高清屏上线条锐利而不会按 4K 位图浪费显存。
 *
 * 说明：本类只接触 `canvas` / `canvas.getContext('2d')`（HTTP 环境里的 DOM 元素），
 * 不访问 window 文档结构、不 import three；在 Node 里用假 canvas 也能实例化和
 * 调用 update()/clear()/destroy()，因此测试不需要 DOM 模拟库。
 */

import { CONFIG } from './config.js';
import { deriveHandNodes } from './handControls.js';

// ===========================================================================
// 常量
// ===========================================================================

const FALLBACK_COLORS = Object.freeze({
  ivory: '#eef2f5',
  gold: '#ffcf7a',
  cyan: '#7fd9ff',
  violet: '#b79cff',
});

/** 21 关节骨架连线（MediaPipe hand connections，22 条）。 */
const HAND_CONNECTIONS = Object.freeze([
  [0, 1], [1, 2], [2, 3], [3, 4], // 拇指
  [0, 5], [5, 6], [6, 7], [7, 8], // 食指
  [5, 9], [9, 10], [10, 11], [11, 12], // 中指
  [9, 13], [13, 14], [14, 15], [15, 16], // 无名指
  [13, 17], [17, 18], [18, 19], [19, 20], // 小指
  [0, 17], [5, 17], // 手掌
]);

const FINGERTIPS = Object.freeze([4, 8, 12, 16, 20]);
const LANDMARK_COUNT = 21;
const THUMB_TIP = 4;
const INDEX_TIP = 8;

/** 衍生节点 → 颜色语义 / 标签兜底。 */
const DERIVED_STYLES = Object.freeze({
  palmCenter: Object.freeze({ color: 'gold', label: '掌心' }),
  pinchMid: Object.freeze({ color: 'gold', label: '捏合' }),
  indexTip: Object.freeze({ color: 'gold', label: '食指' }),
  thumbTip: Object.freeze({ color: 'gold', label: '拇指' }),
  palmSpan: Object.freeze({ color: 'cyan', label: '掌幅' }),
});

const MAX_DPR = 2;
const LABEL_FONT = '600 10px "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
const GLOW_SIZE = 64;
const WAVE_ARROW_TTL_MS = 700;
const MAX_MEASURE_ATTEMPTS = 3;

// ===========================================================================
// 小工具
// ===========================================================================

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

function positiveNumber(value) {
  return isFiniteNumber(value) && value > 0 ? value : 0;
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function fallbackTime() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** '#rrggbb' + alpha → 'rgba(r,g,b,a)'；非预期格式原样返回（允许直接给 rgba()）。 */
function withAlpha(color, alpha) {
  const value = typeof color === 'string' && color.length > 0 ? color : FALLBACK_COLORS.ivory;
  const a = clamp01(alpha);
  if (value[0] !== '#' || value.length !== 7) return value;
  const r = parseInt(value.slice(1, 3), 16);
  const g = parseInt(value.slice(3, 5), 16);
  const b = parseInt(value.slice(5, 7), 16);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return value;
  return `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
}

function resolvePalette() {
  const colors = CONFIG && CONFIG.colors && typeof CONFIG.colors === 'object' ? CONFIG.colors : null;
  return {
    ivory: (colors && colors.ivory) || FALLBACK_COLORS.ivory,
    gold: (colors && colors.gold) || FALLBACK_COLORS.gold,
    cyan: (colors && colors.cyan) || FALLBACK_COLORS.cyan,
    violet: (colors && colors.violet) || FALLBACK_COLORS.violet,
  };
}

/** canvas 的 CSS 尺寸：优先 clientWidth/Height，其次已记录的尺寸，最后位图尺寸。 */
function readCssSize(canvas, cssWidth, cssHeight, dpr) {
  const clientW = positiveNumber(canvas.clientWidth);
  const clientH = positiveNumber(canvas.clientHeight);
  let width = clientW || positiveNumber(cssWidth) || 0;
  let height = clientH || positiveNumber(cssHeight) || 0;
  if (!width && positiveNumber(canvas.width)) width = canvas.width / dpr;
  if (!height && positiveNumber(canvas.height)) height = canvas.height / dpr;
  return { width, height };
}

// ===========================================================================
// HandOverlay
// ===========================================================================

/**
 * 手势骨架叠层。
 *
 * 用法：
 *   const overlay = new HandOverlay(canvas);
 *   overlay.resize();                       // 容器尺寸变化时（内部也会监听 resize）
 *   // 每个检测帧：
 *   overlay.update({ landmarks, videoWidth, videoHeight, state, time: now });
 *   // 关摄像头 / 切页面：
 *   overlay.destroy();
 */
export class HandOverlay {
  #canvas;
  #ctx;
  #palette;
  #dpr = 1;
  #cssWidth = 0;
  #cssHeight = 0;
  #layout = null;
  #glow = null;
  #glowReady = false;
  #resizeHandler = null;
  #lastWave = null;
  #waveAt = 0;
  #destroyed = false;

  /**
   * @param {HTMLCanvasElement} canvas 覆盖在 WebGL 画布上、与 <video> 同尺寸的 2D canvas。
   * @throws {TypeError} canvas 缺失或没有 2D 上下文时抛错（与根目录实现一致，属于编程错误）。
   */
  constructor(canvas) {
    if (!canvas || typeof canvas.getContext !== 'function') {
      throw new TypeError('HandOverlay: 需要传入一个 <canvas> 元素');
    }
    const context = canvas.getContext('2d');
    if (!context) {
      throw new TypeError('HandOverlay: 无法获取 canvas 的 2d 上下文');
    }

    this.#canvas = canvas;
    this.#ctx = context;
    this.#palette = resolvePalette();
    this.#cssWidth = positiveNumber(canvas.clientWidth) || positiveNumber(canvas.width);
    this.#cssHeight = positiveNumber(canvas.clientHeight) || positiveNumber(canvas.height);
    this.#resolveDpr();

    // 浏览器里跟随窗口尺寸变化重算位图尺寸；Node（无 window）下静默跳过。
    if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') {
      this.#resizeHandler = () => this.resize();
      try {
        window.addEventListener('resize', this.#resizeHandler);
      } catch {
        this.#resizeHandler = null;
      }
    }
  }

  get canvas() {
    return this.#canvas;
  }

  get context() {
    return this.#ctx;
  }

  get cssWidth() {
    return this.#cssWidth;
  }

  get cssHeight() {
    return this.#cssHeight;
  }

  get dpr() {
    return this.#dpr;
  }

  /** 按当前 DPR 与 CSS 尺寸重建位图，并设置绘制变换。返回是否成功。 */
  resize() {
    if (this.#destroyed || !this.#canvas || !this.#ctx) return false;
    this.#resolveDpr();
    const size = readCssSize(this.#canvas, this.#cssWidth, this.#cssHeight, this.#dpr);
    this.#cssWidth = size.width;
    this.#cssHeight = size.height;
    this.#layout = null;
    if (!(this.#cssWidth > 0) || !(this.#cssHeight > 0)) {
      this.#canvas.width = 0;
      this.#canvas.height = 0;
      return false;
    }
    const bitmapW = Math.max(1, Math.round(this.#cssWidth * this.#dpr));
    const bitmapH = Math.max(1, Math.round(this.#cssHeight * this.#dpr));
    if (this.#canvas.width !== bitmapW) this.#canvas.width = bitmapW;
    if (this.#canvas.height !== bitmapH) this.#canvas.height = bitmapH;
    try {
      this.#ctx.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0);
    } catch {
      // 某些离屏/测试上下文不支持 setTransform：退化为 1:1 绘制。
      this.#dpr = 1;
    }
    return true;
  }

  /**
   * 画一帧。
   *
   * @param {object} [frame]
   * @param {Array<{x:number,y:number,z?:number}>|null} [frame.landmarks] 原始 normalized 21 点。
   * @param {number} [frame.videoWidth] 视频原始宽度（用于 object-fit: cover 映射）。
   * @param {number} [frame.videoHeight] 视频原始高度。
   * @param {object|null} [frame.state] `HandController.state`（可选，有则画出衍生节点/捏合/挥手）。
   * @param {number} [frame.time] 当前时间（毫秒）；缺省用 performance.now()/Date.now()。
   * @param {boolean} [frame.visible=true] false 时立刻清空画布。
   * @param {boolean} [frame.showNodes=true] 是否绘制 21 关节与衍生点标签。
   * @returns {boolean} 是否真的画了内容（false = 已清空 / 尺寸无效 / 已销毁）。
   */
  update(frame) {
    if (this.#destroyed || !this.#canvas || !this.#ctx) return false;
    const input = frame && typeof frame === 'object' ? frame : {};
    const visible = input.visible !== false;
    const landmarks = Array.isArray(input.landmarks) ? input.landmarks : null;
    const state = input.state && typeof input.state === 'object' ? input.state : null;
    const hasStateNodes = Boolean(state && Array.isArray(state.nodes) && state.nodes.length > 0);
    const stateLost = Boolean(state && state.visible === false);
    const time = isFiniteNumber(input.time) ? input.time : fallbackTime();

    // —— 隐藏 / 手丢失 / 无数据：必须清空，避免残影 ——
    const hasHand = Boolean(landmarks) || hasStateNodes;
    if (!visible || stateLost || !hasHand) {
      this.clear();
      this.#lastWave = null;
      return false;
    }

    const cssWidth = positiveNumber(this.#cssWidth) || positiveNumber(this.#canvas.clientWidth);
    const cssHeight = positiveNumber(this.#cssHeight) || positiveNumber(this.#canvas.clientHeight);
    if (!cssWidth || !cssHeight || !this.#ensureSized()) {
      this.clear();
      return false;
    }

    const ctx = this.#ctx;
    const layout = this.#resolveLayout(input, cssWidth, cssHeight);
    this.#layout = layout;

    // 每帧都从干净画布开始（叠层，不是累积轨迹）。
    this.#erase();

    const showNodes = input.showNodes !== false;
    const pointCount = preparePoints(landmarks, layout, state);
    const derived = collectDerivedNodes(landmarks, layout, state);
    // landmark 全坏了（NaN / 结构错误）时也不要把空画布当成「画成功」。
    if (!pointCount.raw.some(Boolean) && derived.length === 0) {
      this.clear();
      return false;
    }

    // 先画骨架线，再画点与标签（点在线之上）。
    if (showNodes) {
      this.#drawConnections(pointCount.raw);
      this.#drawDerivedGuides(derived);
    }
    this.#drawGlow(pointCount.raw[INDEX_TIP]);
    if (showNodes) {
      this.#drawBasePoints(pointCount.raw);
      this.#drawDerivedNodes(derived);
    }
    this.#drawPinch(state, pointCount, time);
    this.#drawWave(state, time);

    return true;
  }

  /** 清空画布（恢复位图坐标系，避免 DPR 变换导致只清一角）。 */
  clear() {
    if (!this.#canvas || !this.#ctx) return;
    const ctx = this.#ctx;
    const canvas = this.#canvas;
    try {
      if (typeof ctx.save === 'function') ctx.save();
      if (typeof ctx.setTransform === 'function') ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (typeof ctx.restore === 'function') ctx.restore();
      if (typeof ctx.setTransform === 'function' && this.#dpr !== 1) {
        ctx.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0);
      }
    } catch {
      // 上下文已失效（页面卸载 / canvas 被回收）时忽略。
    }
  }

  /** 清空并释放引用；之后所有调用都是安全的空操作。 */
  destroy() {
    if (this.#destroyed) return;
    this.clear();
    if (this.#resizeHandler) {
      try {
        window.removeEventListener('resize', this.#resizeHandler);
      } catch {
        // 忽略：页面正在卸载时 window 可能已不可用。
      }
      this.#resizeHandler = null;
    }
    this.#destroyed = true;
    this.#canvas = null;
    this.#ctx = null;
    this.#glow = null;
    this.#glowReady = true;
    this.#layout = null;
    this.#lastWave = null;
  }

  // -------------------------------------------------------------------------
  // 尺寸 / 映射
  // -------------------------------------------------------------------------

  #resolveDpr() {
    let dpr = 1;
    try {
      const globalDpr = typeof globalThis !== 'undefined' ? globalThis.devicePixelRatio : undefined;
      const windowDpr = typeof window !== 'undefined' ? window.devicePixelRatio : undefined;
      dpr = positiveNumber(globalDpr) || positiveNumber(windowDpr) || 1;
    } catch {
      dpr = 1;
    }
    this.#dpr = Math.min(MAX_DPR, Math.max(1, dpr));
  }

  #ensureSized() {
    const cssWidth = this.#cssWidth;
    const cssHeight = this.#cssHeight;
    const expectedW = Math.max(1, Math.round(cssWidth * this.#dpr));
    const expectedH = Math.max(1, Math.round(cssHeight * this.#dpr));
    if (this.#canvas.width !== expectedW || this.#canvas.height !== expectedH) {
      return this.resize();
    }
    return true;
  }

  /** object-fit: cover 映射参数；video 尺寸非法时退化为「按 CSS 尺寸 1:1」。 */
  #resolveLayout(input, cssWidth, cssHeight) {
    const videoW = positiveNumber(input.videoWidth);
    const videoH = positiveNumber(input.videoHeight);
    const sourceW = videoW > 0 ? videoW : cssWidth;
    const sourceH = videoH > 0 ? videoH : cssHeight;
    const scale = Math.max(cssWidth / sourceW, cssHeight / sourceH);
    const drawnW = sourceW * scale;
    const drawnH = sourceH * scale;
    return {
      scale,
      sourceW,
      sourceH,
      drawnW,
      drawnH,
      offsetX: (cssWidth - drawnW) / 2,
      offsetY: (cssHeight - drawnH) / 2,
      aspect: sourceW > 0 && sourceH > 0 ? sourceW / sourceH : 1,
    };
  }

  // -------------------------------------------------------------------------
  // 绘制
  // -------------------------------------------------------------------------

  #erase() {
    const ctx = this.#ctx;
    const canvas = this.#canvas;
    const dpr = this.#dpr;
    try {
      if (typeof ctx.setTransform === 'function') ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (typeof ctx.setTransform === 'function') ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    } catch {
      // 忽略：上下文失效。
    }
  }

  #drawConnections(points) {
    const ctx = this.#ctx;
    const palette = this.#palette;
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = withAlpha(palette.ivory, 0.18);
    ctx.lineCap = 'round';
    ctx.beginPath();
    let drawn = 0;
    for (const [from, to] of HAND_CONNECTIONS) {
      const a = points[from];
      const b = points[to];
      if (!a || !b) continue;
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      drawn += 1;
    }
    if (drawn > 0) ctx.stroke();
    ctx.restore();
  }

  #drawBasePoints(points) {
    const ctx = this.#ctx;
    const palette = this.#palette;
    ctx.save();
    ctx.fillStyle = withAlpha(palette.ivory, 0.42);
    ctx.beginPath();
    for (let index = 0; index < LANDMARK_COUNT; index += 1) {
      const point = points[index];
      if (!point) continue;
      ctx.moveTo(point.x + 1.7, point.y);
      ctx.arc(point.x, point.y, 1.7, 0, Math.PI * 2);
    }
    ctx.fill();

    // 五个指尖略亮一点，便于看清手指方向。
    ctx.fillStyle = withAlpha(palette.ivory, 0.72);
    ctx.beginPath();
    for (const index of FINGERTIPS) {
      const point = points[index];
      if (!point) continue;
      ctx.moveTo(point.x + 2.2, point.y);
      ctx.arc(point.x, point.y, 2.2, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.restore();
  }

  #drawDerivedNodes(derived) {
    if (!derived.length) return;
    const ctx = this.#ctx;
    ctx.save();
    ctx.font = LABEL_FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const node of derived) {
      const color = node.color === 'cyan' ? this.#palette.cyan : this.#palette.gold;
      ctx.fillStyle = withAlpha(color, 0.95);
      ctx.beginPath();
      ctx.arc(node.px, node.py, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = withAlpha(color, 0.45);
      ctx.beginPath();
      ctx.arc(node.px, node.py, 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = withAlpha(color, 0.88);
      ctx.fillText(node.label, node.px + 7, node.py - 7);
    }
    ctx.restore();
  }

  /** 掌心 → 掌幅末端的短指示线（低透明度，说明方向含义）。 */
  #drawDerivedGuides(derived) {
    if (!derived.length) return;
    const byId = new Map();
    for (const node of derived) byId.set(node.id, node);
    const center = byId.get('palmCenter');
    if (!center) return;
    const ctx = this.#ctx;
    ctx.save();
    ctx.lineWidth = 1;
    ctx.lineCap = 'round';
    for (const [id, alpha] of [['palmSpan', 0.22]]) {
      const end = byId.get(id);
      if (!end) continue;
      ctx.strokeStyle = withAlpha(this.#palette.cyan, alpha);
      ctx.beginPath();
      ctx.moveTo(center.px, center.py);
      ctx.lineTo(end.px, end.py);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** 食指指尖光晕：优先用离屏精灵，无 document 时退回普通圆点。 */
  #drawGlow(point) {
    if (!point) return;
    const ctx = this.#ctx;
    const sprite = this.#ensureGlowSprite();
    ctx.save();
    if (sprite) {
      const size = 34;
      ctx.globalAlpha = 0.55;
      ctx.drawImage(sprite, point.x - size / 2, point.y - size / 2, size, size);
    } else {
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = this.#palette.ivory;
      ctx.beginPath();
      ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  #ensureGlowSprite() {
    if (this.#glowReady) return this.#glow;
    this.#glowReady = true;
    try {
      if (typeof document === 'undefined' || !document || typeof document.createElement !== 'function') {
        return null;
      }
      const sprite = document.createElement('canvas');
      if (!sprite || typeof sprite.getContext !== 'function') return null;
      sprite.width = GLOW_SIZE;
      sprite.height = GLOW_SIZE;
      const spriteCtx = sprite.getContext('2d');
      if (!spriteCtx || typeof spriteCtx.createRadialGradient !== 'function') return null;
      const radius = GLOW_SIZE / 2;
      const gradient = spriteCtx.createRadialGradient(radius, radius, 0, radius, radius, radius);
      gradient.addColorStop(0, withAlpha(this.#palette.ivory, 0.9));
      gradient.addColorStop(0.35, withAlpha(this.#palette.gold, 0.45));
      gradient.addColorStop(1, withAlpha(this.#palette.gold, 0));
      spriteCtx.fillStyle = gradient;
      spriteCtx.fillRect(0, 0, GLOW_SIZE, GLOW_SIZE);
      this.#glow = sprite;
    } catch {
      this.#glow = null;
    }
    return this.#glow;
  }

  /** 捏合反馈：拇指-食指连线高亮 + 中点脉冲环。 */
  #drawPinch(state, points, time) {
    const pinch = state && state.pinch && typeof state.pinch === 'object' ? state.pinch : null;
    if (!pinch || pinch.active !== true) return;
    const thumb = points.raw[THUMB_TIP];
    const index = points.raw[INDEX_TIP];
    if (!thumb || !index) return;
    const palette = this.#palette;
    const ctx = this.#ctx;
    const strength = clamp01(isFiniteNumber(pinch.strength) ? pinch.strength : 0.6);
    const midX = (thumb.x + index.x) / 2;
    const midY = (thumb.y + index.y) / 2;
    const pulse = 0.5 + 0.5 * Math.sin(time * 0.008);

    ctx.save();
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = withAlpha(palette.gold, 0.45 + 0.4 * strength);
    ctx.beginPath();
    ctx.moveTo(thumb.x, thumb.y);
    ctx.lineTo(index.x, index.y);
    ctx.stroke();

    ctx.strokeStyle = withAlpha(palette.gold, 0.35 + 0.35 * pulse);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(midX, midY, 7 + 3 * pulse, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = withAlpha(palette.gold, 0.9);
    ctx.beginPath();
    ctx.arc(midX, midY, 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /**
   * 挥手方向箭头。`state.wave` 在 controller 里只保持约 400ms，这里再跟踪一次
   * 「同一 wave 对象」的首次出现时间，把箭头淡出拉长到 WAVE_ARROW_TTL_MS。
   */
  #drawWave(state, time) {
    const wave = state && state.wave && typeof state.wave === 'object' ? state.wave : null;
    if (!wave || (wave.direction !== 'next' && wave.direction !== 'prev')) {
      this.#lastWave = null;
      return;
    }
    if (wave !== this.#lastWave) {
      this.#lastWave = wave;
      this.#waveAt = time;
    }
    const age = Math.max(0, time - this.#waveAt);
    if (age > WAVE_ARROW_TTL_MS) return;
    if (!this.#layout) return;

    // 用 state.palm（镜像后的 0..1）定位，没有就用画布中心偏下。
    const palm = state && state.palm && typeof state.palm === 'object' ? state.palm : null;
    const layout = this.#layout;
    let baseX = (this.#cssWidth || this.#canvas.width) * 0.5;
    let baseY = (this.#cssHeight || this.#canvas.height) * 0.55;
    if (palm && isFiniteNumber(palm.x) && isFiniteNumber(palm.y)) {
      baseX = layout.offsetX + clamp01(palm.x) * layout.drawnW;
      baseY = layout.offsetY + clamp01(palm.y) * layout.drawnH;
    }

    const direction = wave.direction === 'prev' ? -1 : 1;
    const alpha = Math.max(0, 1 - age / WAVE_ARROW_TTL_MS);
    const strength = clamp01(isFiniteNumber(wave.strength) ? wave.strength : 0.6);
    const offset = 30;
    const ctx = this.#ctx;
    const palette = this.#palette;

    ctx.save();
    ctx.translate(baseX + direction * offset, baseY);
    ctx.strokeStyle = withAlpha(palette.gold, 0.25 + 0.65 * alpha);
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // 两个「>」/「<」形箭头，表示连续可切换。
    for (let step = 0; step < 2; step += 1) {
      const shift = direction * step * 7;
      ctx.beginPath();
      ctx.moveTo(shift - direction * 4, -5);
      ctx.lineTo(shift + direction * 3, 0);
      ctx.lineTo(shift - direction * 4, 5);
      ctx.stroke();
    }
    ctx.fillStyle = withAlpha(palette.gold, 0.55 + 0.35 * strength);
    ctx.font = LABEL_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(wave.direction === 'next' ? '下一颗' : '上一颗', 0, -10);
    ctx.restore();
  }
}

// ===========================================================================
// 点集准备
// ===========================================================================

/**
 * 把 landmarks / state.nodes 映射成屏幕坐标。
 * 返回 { raw: 21 个投影后的原始点或 null, mirrored: 21 个已镜像点 }。
 * raw 供捏合连线使用（4/8 索引与 landmark 索引一致）；两者都用于绘制。
 */
function preparePoints(landmarks, layout, state) {
  const raw = new Array(LANDMARK_COUNT).fill(null);
  const mirrored = new Array(LANDMARK_COUNT).fill(null);

  if (landmarks && landmarks.length >= LANDMARK_COUNT) {
    for (let index = 0; index < LANDMARK_COUNT; index += 1) {
      const point = landmarks[index];
      if (!point || !isFiniteNumber(point.x) || !isFiniteNumber(point.y)) continue;
      const projected = projectRaw(point.x, point.y, layout);
      raw[index] = projected;
      mirrored[index] = projected;
    }
    return { raw, mirrored };
  }

  // 没有原始 landmark 时退化为使用 state.nodes 的 base 节点（已经是镜像坐标）。
  const nodes = state && Array.isArray(state.nodes) ? state.nodes : null;
  if (nodes) {
    let cursor = 0;
    for (const node of nodes) {
      if (!node || node.kind !== 'base') continue;
      if (cursor >= LANDMARK_COUNT) break;
      if (!isFiniteNumber(node.x) || !isFiniteNumber(node.y)) {
        cursor += 1;
        continue;
      }
      const projected = projectMirrored(node.x, node.y, layout);
      raw[cursor] = projected;
      mirrored[cursor] = projected;
      cursor += 1;
    }
  }
  return { raw, mirrored };
}

/**
 * 6 个衍生节点的屏幕坐标。优先用 state.nodes（controller 已算好，含平滑/时序），
 * 否则用 deriveHandNodes 现算（overlay 单独使用也完整）。
 */
function collectDerivedNodes(landmarks, layout, state) {
  let nodes = null;
  if (state && Array.isArray(state.nodes) && state.nodes.length > 0) {
    nodes = state.nodes.filter((node) => node && node.kind === 'derived');
  }
  if (!nodes || nodes.length === 0) {
    if (!landmarks || landmarks.length < LANDMARK_COUNT) return [];
    const derived = deriveHandNodes(landmarks, layout.aspect);
    if (!derived) return [];
    nodes = derived.nodes.filter((node) => node && node.kind === 'derived');
  }

  const result = [];
  for (const node of nodes) {
    if (!node || typeof node.id !== 'string') continue;
    const style = DERIVED_STYLES[node.id] || { color: 'gold', label: node.label || '' };
    const x = isFiniteNumber(node.x) ? node.x : null;
    const y = isFiniteNumber(node.y) ? node.y : null;
    if (x === null || y === null) continue;
    const projected = projectMirrored(x, y, layout);
    result.push({
      id: node.id,
      label: typeof node.label === 'string' && node.label ? node.label : style.label,
      color: style.color,
      px: projected.x,
      py: projected.y,
    });
  }
  return result;
}

// ===========================================================================
// 投影
// ===========================================================================

/** 原始 normalized 坐标 → 屏幕像素（object-fit: cover + 自拍镜像 x=1-x）。 */
function projectRaw(x, y, layout) {
  return {
    x: layout.offsetX + (1 - clamp01(x)) * layout.drawnW,
    y: layout.offsetY + clamp01(y) * layout.drawnH,
  };
}

/** 已镜像的 normalized 坐标 → 屏幕像素。 */
function projectMirrored(x, y, layout) {
  return {
    x: layout.offsetX + clamp01(x) * layout.drawnW,
    y: layout.offsetY + clamp01(y) * layout.drawnH,
  };
}

/** 供测试 / 调试：覆盖映射参数（不修改内部状态）。 */
export function computeCoverLayout(cssWidth, cssHeight, videoWidth, videoHeight) {
  const cw = positiveNumber(cssWidth) || 1;
  const ch = positiveNumber(cssHeight) || 1;
  const vw = positiveNumber(videoWidth) || cw;
  const vh = positiveNumber(videoHeight) || ch;
  const scale = Math.max(cw / vw, ch / vh);
  const drawnW = vw * scale;
  const drawnH = vh * scale;
  return {
    scale,
    sourceW: vw,
    sourceH: vh,
    drawnW,
    drawnH,
    offsetX: (cw - drawnW) / 2,
    offsetY: (ch - drawnH) / 2,
    aspect: vw / vh,
  };
}
