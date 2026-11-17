/**
 * 指尖生花 / Fingertip Bloom
 * src/handTracker.js — 摄像头 + MediaPipe Hand Landmarker 手部追踪器。
 *
 * 职责：
 *   1. 用 getUserMedia 打开摄像头（只请求 video，绝不请求麦克风）；
 *   2. 从本地 vendor 目录动态加载 @mediapipe/tasks-vision 与 hand_landmarker.task；
 *   3. 以约 30fps 的节奏做 VIDEO 模式检测，把每一帧的手部数据交给 onFrame；
 *   4. 页面隐藏时暂停检测，恢复可见时继续；
 *   5. stop() 可重复调用，负责停止轨道、清空 srcObject、关闭 landmarker。
 *
 * 对外接口（与 docs/CONTRACT.md 一致）：
 *   const tracker = new HandTracker({ video, onFrame, onStatus, onError });
 *   await tracker.start();       // 失败时 throw Error（带 .code / .title / .hint）
 *   tracker.stop();
 *   tracker.running;
 *   describeCameraError(error) → { code, title, message, hint }
 *
 * onStatus 的阶段：'camera' | 'model' | 'ready' | 'stopped' | 'error'
 * onFrame 的参数：
 *   {
 *     landmarks,     // 21 点数组；没有检测到手时为 null
 *     handedness,    // 'Left' | 'Right' | null
 *     confidence,    // 0..1，手部存在置信度
 *     videoWidth, videoHeight, aspect,
 *     timestampMs,   // 单调递增的检测时间（毫秒）
 *   }
 * onError 只在不可恢复的错误时触发（连续检测失败 / 运行时失效），随后追踪器自动停止。
 *
 * 模型资源全部是本地文件；用 import.meta.url 解析路径，因此无论页面挂在域名根路径
 * 还是子路径下，都能从 /vendor/mediapipe/ 正确加载，不产生 404。
 */

import { CONFIG } from './config.js';

/** 默认资源路径（相对于本模块，即 /src/ 的上一级 /vendor/）。 */
const DEFAULT_VISION_BUNDLE = new URL('../vendor/mediapipe/vision_bundle.mjs', import.meta.url);
const DEFAULT_WASM_DIR = new URL('../vendor/mediapipe/wasm/', import.meta.url);
const DEFAULT_MODEL = new URL('../vendor/mediapipe/hand_landmarker.task', import.meta.url);

const MAX_CONSECUTIVE_DETECTION_FAILURES = 3;
const VIDEO_READY_TIMEOUT_MS = 6000;
const RVFC_WATCHDOG_MS = 250;

/** 错误 code → 面向用户的中文文案。UI 可以直接展示这些字段。 */
const ERROR_COPY = Object.freeze({
  CAMERA_UNSUPPORTED: Object.freeze({
    title: '浏览器不支持摄像头',
    message: '当前浏览器或页面环境无法访问摄像头。',
    hint: '请使用最新版 Chrome / Edge，并通过 localhost 或 https 打开页面；也可以先进入演示模式。',
  }),
  CAMERA_PERMISSION_DENIED: Object.freeze({
    title: '摄像头权限被拒绝',
    message: '浏览器阻止了摄像头访问。',
    hint: '点击地址栏左侧的摄像头图标，允许访问后重试；也可以先进入演示模式。',
  }),
  CAMERA_NOT_FOUND: Object.freeze({
    title: '没有找到摄像头',
    message: '没有检测到可用的摄像头设备。',
    hint: '请连接摄像头后重试，或先进入演示模式。',
  }),
  CAMERA_IN_USE: Object.freeze({
    title: '摄像头被占用',
    message: '摄像头正被其他程序使用。',
    hint: '请关闭正在使用摄像头的应用（如会议软件），然后重试。',
  }),
  CAMERA_FAILED: Object.freeze({
    title: '摄像头启动失败',
    message: '摄像头未能正常启动。',
    hint: '请检查设备连接后重试，或先进入演示模式。',
  }),
  MODEL_LOAD_FAILED: Object.freeze({
    title: '手部模型加载失败',
    message: '无法加载本地的手部识别模型。',
    hint: '请确认 vendor/mediapipe 文件完整，然后刷新页面重试；也可以先进入演示模式。',
  }),
});

const KNOWN_ERROR_CODES = new Set(Object.keys(ERROR_COPY));
const FALLBACK_ERROR_CODE = 'CAMERA_FAILED';

/** 浏览器 DOMException.name → 内部错误 code。 */
const ERROR_NAME_TO_CODE = Object.freeze({
  NotAllowedError: 'CAMERA_PERMISSION_DENIED',
  PermissionDeniedError: 'CAMERA_PERMISSION_DENIED',
  SecurityError: 'CAMERA_UNSUPPORTED',
  NotFoundError: 'CAMERA_NOT_FOUND',
  DevicesNotFoundError: 'CAMERA_NOT_FOUND',
  NotReadableError: 'CAMERA_IN_USE',
  TrackStartError: 'CAMERA_IN_USE',
  AbortError: 'CAMERA_IN_USE',
  NotSupportedError: 'CAMERA_IN_USE',
  OverconstrainedError: 'CAMERA_FAILED',
  ConstraintNotSatisfiedError: 'CAMERA_FAILED',
  TypeError: 'CAMERA_UNSUPPORTED',
});

function createTrackerError(code, overrides = {}, cause) {
  const resolvedCode = KNOWN_ERROR_CODES.has(code) ? code : FALLBACK_ERROR_CODE;
  const copy = ERROR_COPY[resolvedCode];
  const message = overrides.message ?? copy.message;
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  error.code = resolvedCode;
  error.title = overrides.title ?? copy.title;
  error.message = message;
  error.hint = overrides.hint ?? copy.hint;
  return error;
}

/**
 * 把任意摄像头 / 模型错误翻译成统一结构，UI 可直接展示：
 *   { code, title, message, hint }
 * 永远不抛错；未知错误回退到 CAMERA_FAILED。
 *
 * @param {unknown} error
 * @returns {{code: string, title: string, message: string, hint: string}}
 */
export function describeCameraError(error) {
  try {
    if (error && typeof error === 'object' && typeof error.code === 'string' && KNOWN_ERROR_CODES.has(error.code)) {
      const copy = ERROR_COPY[error.code];
      return {
        code: error.code,
        title: typeof error.title === 'string' && error.title ? error.title : copy.title,
        message: typeof error.message === 'string' && error.message ? error.message : copy.message,
        hint: typeof error.hint === 'string' && error.hint ? error.hint : copy.hint,
      };
    }

    const name = error && typeof error === 'object' && typeof error.name === 'string' ? error.name : '';
    const code = ERROR_NAME_TO_CODE[name] ?? FALLBACK_ERROR_CODE;
    const copy = ERROR_COPY[code];
    return { code, title: copy.title, message: copy.message, hint: copy.hint };
  } catch {
    const copy = ERROR_COPY[FALLBACK_ERROR_CODE];
    return { code: FALLBACK_ERROR_CODE, title: copy.title, message: copy.message, hint: copy.hint };
  }
}

/** 只加载一次 tasks-vision；失败后清空缓存，允许用户重试。 */
let visionModulePromise = null;
function loadVisionModule() {
  if (!visionModulePromise) {
    visionModulePromise = import(DEFAULT_VISION_BUNDLE.href).catch((error) => {
      visionModulePromise = null;
      throw error;
    });
  }
  return visionModulePromise;
}

/** MediaPipe 的 close() 在版本间可能是 void 也可能是 Promise，两种都安全处理。 */
function closeLandmarker(landmarker) {
  if (!landmarker) return;
  try {
    const result = landmarker.close?.();
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch {
    /* 关闭失败不应影响 retry / 页面其他逻辑 */
  }
}

function stopStream(stream) {
  if (!stream || typeof stream.getTracks !== 'function') return;
  try {
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        /* 单个轨道关闭失败不影响其他轨道 */
      }
    }
  } catch {
    /* 忽略非标准 stream 实现 */
  }
}

function isDocumentHidden() {
  return typeof document !== 'undefined' && document.hidden === true;
}

function nowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
  return Date.now();
}

/** 把构造参数里的相对路径 / URL 统一解析为 URL；非法时退回默认值。 */
function resolveAssetUrl(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value instanceof URL) return value;
  try {
    return new URL(String(value), import.meta.url);
  } catch {
    return fallback;
  }
}

/** 等待 <video> 真正有画面（readyState 足够且拿到尺寸），超时抛 CAMERA_FAILED。 */
function waitForVideoReady(video, timeoutMs = VIDEO_READY_TIMEOUT_MS) {
  const isReady = () => video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;
  if (isReady()) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener('loadedmetadata', check);
      video.removeEventListener('loadeddata', check);
      video.removeEventListener('resize', check);
    };

    const check = () => {
      if (settled || !isReady()) return;
      settled = true;
      cleanup();
      resolve();
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        createTrackerError('CAMERA_FAILED', {
          title: '摄像头画面未就绪',
          message: '摄像头已连接，但长时间没有收到画面。',
          hint: '请确认摄像头没有被其他程序占用，然后重试；也可以先进入演示模式。',
        }),
      );
    }, timeoutMs);

    video.addEventListener('loadedmetadata', check);
    video.addEventListener('loadeddata', check);
    video.addEventListener('resize', check);
    check();
  });
}

/**
 * 摄像头 + MediaPipe 手部追踪。
 */
export class HandTracker {
  #video;
  #onFrame;
  #onStatus;
  #onError;

  #modelUrl;
  #wasmDir;

  #running = false;
  #startPromise = null;
  #stopToken = 0;

  #stream = null;
  #landmarker = null;
  #fileset = null;
  #delegate = 'GPU';
  #cpuFallbackTried = false;

  #frameHandle = 0;
  #timerHandle = 0;
  #watchdogHandle = 0;
  #rvfcUnreliable = false;
  #detecting = false;
  #paused = true;

  #lastTickAt = 0;
  #lastTimestamp = 0;
  #maxHands = 1;
  #consecutiveFailures = 0;
  #frameErrorLogged = false;
  #visibilityHandler = null;

  /**
   * @param {object} options
   * @param {HTMLVideoElement} options.video 隐藏的 <video muted playsinline>
   * @param {(frame: object) => void} [options.onFrame]
   * @param {(status: {phase: string, message: string}) => void} [options.onStatus]
   * @param {(error: Error) => void} [options.onError] 不可恢复错误（随后 tracker 会自动停止）
   * @param {string|URL} [options.modelPath] 覆盖默认 hand_landmarker.task 路径
   * @param {string|URL} [options.wasmPath] 覆盖默认 wasm 目录路径
   */
  constructor({ video, onFrame, onStatus, onError, modelPath, wasmPath, maxHands } = {}) {
    if (!video || typeof video !== 'object') {
      throw new TypeError('HandTracker 需要一个 <video> 元素');
    }
    this.#video = video;
    this.#onFrame = typeof onFrame === 'function' ? onFrame : null;
    this.#onStatus = typeof onStatus === 'function' ? onStatus : null;
    this.#onError = typeof onError === 'function' ? onError : null;
    this.#modelUrl = resolveAssetUrl(modelPath, DEFAULT_MODEL);
    this.#wasmDir = resolveAssetUrl(wasmPath, DEFAULT_WASM_DIR);
    this.#maxHands = Math.max(1, Math.min(2, Number(maxHands) || 1));
  }

  /** 是否正在追踪（start 成功后为 true，stop 后立即为 false）。 */
  get running() {
    return this.#running;
  }

  /**
   * 打开摄像头 + 加载模型 + 启动检测循环。
   * 失败时抛出的 Error 带有 .code / .title / .message / .hint，同时通过 onStatus('error') 广播。
   * 若 start 过程中调用 stop()，本 Promise 会安静地 resolve（不抛错）。
   *
   * @returns {Promise<void>}
   */
  start() {
    if (this.#running) return Promise.resolve();
    if (this.#startPromise) return this.#startPromise;

    const promise = this.#startInternal();
    this.#startPromise = promise;
    const clear = () => {
      if (this.#startPromise === promise) this.#startPromise = null;
    };
    promise.then(clear, clear);
    return promise;
  }

  /** 停止摄像头 / 检测循环 / landmarker；可重复调用，重复调用不会抛错。 */
  stop() {
    const wasActive =
      this.#running || Boolean(this.#stream) || Boolean(this.#landmarker) || Boolean(this.#startPromise);

    this.#stopToken += 1; // 让任何进行中的 start 立即失效
    this.#running = false;
    this.#paused = true;
    this.#startPromise = null;
    this.#cancelScheduledFrame();
    this.#detachVisibility();
    this.#teardownSession();

    if (wasActive) this.#emitStatus('stopped', '摄像头已关闭');
  }

  // -------------------------------------------------------------------------
  // 启动流程
  // -------------------------------------------------------------------------

  async #startInternal() {
    const token = ++this.#stopToken;

    try {
      const mediaDevices = typeof navigator !== 'undefined' ? navigator.mediaDevices : null;
      if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
        throw createTrackerError('CAMERA_UNSUPPORTED');
      }

      this.#emitStatus('camera', '正在请求摄像头…');
      const stream = await this.#openCamera(mediaDevices);
      if (this.#isCancelled(token)) {
        stopStream(stream);
        return;
      }
      this.#stream = stream;

      // muted + playsinline 是浏览器允许自动播放 (<video> 无声音) 的前提。
      const video = this.#video;
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;

      this.#emitStatus('camera', '摄像头已连接，正在等待画面…');
      await this.#playVideo(video);
      if (this.#isCancelled(token)) return;
      await waitForVideoReady(video);
      if (this.#isCancelled(token)) return;

      this.#emitStatus('model', '正在加载手部识别模型…');
      const created = await this.#createLandmarker();
      if (this.#isCancelled(token)) {
        closeLandmarker(created.landmarker);
        return;
      }

      this.#landmarker = created.landmarker;
      this.#fileset = created.fileset;
      this.#delegate = created.delegate;
      this.#cpuFallbackTried = created.delegate === 'CPU';

      this.#running = true;
      this.#paused = isDocumentHidden();
      this.#consecutiveFailures = 0;
      this.#frameErrorLogged = false;
      this.#attachVisibility();
      this.#emitStatus('ready', '手部识别已就绪');
      this.#schedule();
    } catch (error) {
      // stop() 在启动途中被调用：安静收尾，不向 UI 报错。
      if (this.#isCancelled(token)) return;

      this.#running = false;
      this.#paused = true;
      this.#cancelScheduledFrame();
      this.#detachVisibility();
      this.#teardownSession();

      const failure = this.#toFriendlyError(error);
      this.#emitStatus('error', failure.message);
      this.#emitError(failure);
      throw failure;
    }
  }

  #isCancelled(token) {
    return token !== this.#stopToken;
  }

  /** 以理想参数请求摄像头；遇到 OverconstrainedError 时退回无约束的纯视频请求。 */
  async #openCamera(mediaDevices) {
    const videoConstraints = {
      width: { ...CONFIG.camera.width },
      height: { ...CONFIG.camera.height },
      frameRate: { ...CONFIG.camera.frameRate },
      facingMode: CONFIG.camera.facingMode,
    };

    try {
      return await mediaDevices.getUserMedia({ audio: false, video: videoConstraints });
    } catch (error) {
      if (error && error.name === 'OverconstrainedError') {
        try {
          // 某些摄像头不支持 1280x720 / 指定 facingMode：退回默认视频参数。
          return await mediaDevices.getUserMedia({ audio: false, video: true });
        } catch (retryError) {
          throw this.#toFriendlyError(retryError);
        }
      }
      throw this.#toFriendlyError(error);
    }
  }

  async #playVideo(video) {
    if (typeof video.play !== 'function') return;
    try {
      await video.play();
    } catch (error) {
      throw createTrackerError(
        'CAMERA_FAILED',
        {
          title: '摄像头画面无法播放',
          message: '浏览器阻止了摄像头画面播放。',
          hint: '请点击页面任意位置后重试；也可以先进入演示模式。',
        },
        error,
      );
    }
  }

  /**
   * 加载 tasks-vision 与模型，返回 { landmarker, fileset, delegate }。
   * 先尝试 GPU；GPU 不可用时自动回退 CPU（保留 fileset 供运行时 fallback 重建）。
   */
  async #createLandmarker() {
    let vision;
    try {
      vision = await loadVisionModule();
    } catch (error) {
      throw createTrackerError('MODEL_LOAD_FAILED', {}, error);
    }

    let fileset;
    try {
      fileset = await vision.FilesetResolver.forVisionTasks(this.#wasmDir.href);
    } catch (error) {
      throw createTrackerError(
        'MODEL_LOAD_FAILED',
        { title: '手部模型初始化失败', message: '无法初始化手部识别运行时。' },
        error,
      );
    }

    try {
      const landmarker = await vision.HandLandmarker.createFromOptions(
        fileset,
        this.#buildLandmarkerOptions('GPU'),
      );
      return { landmarker, fileset, delegate: 'GPU' };
    } catch {
      this.#emitStatus('model', 'GPU 加速不可用，正在使用 CPU 模式…');
      try {
        const landmarker = await vision.HandLandmarker.createFromOptions(
          fileset,
          this.#buildLandmarkerOptions('CPU'),
        );
        return { landmarker, fileset, delegate: 'CPU' };
      } catch (cpuError) {
        throw createTrackerError('MODEL_LOAD_FAILED', { message: '手部识别模型加载失败。' }, cpuError);
      }
    }
  }

  #buildLandmarkerOptions(delegate) {
    const tracking = CONFIG.tracking;
    return {
      baseOptions: {
        modelAssetPath: this.#modelUrl.href,
        delegate,
      },
      runningMode: 'VIDEO',
      numHands: this.#maxHands ?? tracking.maxHands ?? 1,
      minHandDetectionConfidence: tracking.minHandDetectionConfidence,
      minHandPresenceConfidence: tracking.minHandPresenceConfidence,
      minTrackingConfidence: tracking.minTrackingConfidence,
    };
  }

  // -------------------------------------------------------------------------
  // 检测循环
  // -------------------------------------------------------------------------

  /**
   * 安排下一次检测：
   *   - 优先 requestVideoFrameCallback（与摄像头帧对齐、省电）；
   *   - 隐藏的 <video> 在部分浏览器不会触发 rVFC，250ms 看门狗后切换到定时器；
   *   - 没有 rVFC 的浏览器直接用 setTimeout 定时器。
   */
  #schedule() {
    if (!this.#running || this.#paused) return;
    if (this.#frameHandle || this.#timerHandle || this.#watchdogHandle) return;

    const video = this.#video;
    if (!this.#rvfcUnreliable && typeof video.requestVideoFrameCallback === 'function') {
      this.#frameHandle = video.requestVideoFrameCallback((now) => {
        this.#clearWatchdog();
        this.#frameHandle = 0;
        void this.#tick(now);
      });
      this.#watchdogHandle = setTimeout(() => {
        this.#watchdogHandle = 0;
        this.#switchToTimerLoop();
      }, RVFC_WATCHDOG_MS);
      return;
    }

    this.#scheduleTimerTick(CONFIG.tracking.intervalMs);
  }

  #scheduleTimerTick(delay) {
    this.#timerHandle = setTimeout(() => {
      this.#timerHandle = 0;
      void this.#tick(nowMs());
    }, Math.max(0, delay));
  }

  #switchToTimerLoop() {
    if (!this.#running || this.#paused) return;
    if (!this.#frameHandle) {
      // rVFC 其实已经触发（或已被取消），交给正常调度即可。
      this.#schedule();
      return;
    }
    this.#rvfcUnreliable = true;
    const video = this.#video;
    if (typeof video.cancelVideoFrameCallback === 'function') {
      try {
        video.cancelVideoFrameCallback(this.#frameHandle);
      } catch {
        /* 忽略取消失败 */
      }
    }
    this.#frameHandle = 0;
    this.#lastTickAt = 0;
    this.#scheduleTimerTick(0);
  }

  async #tick(now) {
    if (!this.#running || this.#paused) return;

    const video = this.#video;
    if (
      !video ||
      video.readyState < 2 ||
      video.paused ||
      video.ended ||
      !video.videoWidth ||
      !video.videoHeight
    ) {
      this.#schedule();
      return;
    }

    // 即使浏览器以 60fps 回调，也只按约 30fps 做检测，避免浪费 GPU/CPU。
    const interval = CONFIG.tracking.intervalMs;
    const stamp = Number.isFinite(now) ? now : nowMs();
    if (this.#lastTickAt && stamp - this.#lastTickAt < interval * 0.8) {
      this.#schedule();
      return;
    }
    this.#lastTickAt = stamp;

    if (this.#detecting) {
      this.#schedule();
      return;
    }
    this.#detecting = true;
    try {
      await this.#detect();
    } finally {
      this.#detecting = false;
      this.#schedule();
    }
  }

  async #detect() {
    const video = this.#video;
    const landmarker = this.#landmarker;
    if (!landmarker || !this.#running) return;

    let result;
    try {
      result = landmarker.detectForVideo(video, this.#nextTimestamp());
    } catch (error) {
      const recovered = await this.#recoverToCpu();
      if (!recovered) {
        if (!this.#landmarker) {
          this.#fatalFailure(
            createTrackerError(
              'MODEL_LOAD_FAILED',
              {
                title: '手部识别不可用',
                message: '手部识别模型在运行中失效。',
                hint: '请刷新页面重试；也可以先进入演示模式。',
              },
              error,
            ),
          );
          return;
        }
        this.#onDetectionFailure(error);
        return;
      }

      const active = this.#landmarker;
      if (!active) return;
      try {
        result = active.detectForVideo(video, this.#nextTimestamp());
      } catch (retryError) {
        this.#onDetectionFailure(retryError);
        return;
      }
    }

    this.#consecutiveFailures = 0;
    this.#emitFrame(result, this.#lastTimestamp);
  }

  /** GPU 委托在运行中出错时重建一个 CPU landmarker；返回是否恢复成功。 */
  async #recoverToCpu() {
    if (this.#delegate !== 'GPU' || this.#cpuFallbackTried || !this.#fileset) return false;
    this.#cpuFallbackTried = true;
    this.#emitStatus('model', 'GPU 加速不可用，正在切换到 CPU 模式…');

    const previous = this.#landmarker;
    this.#landmarker = null;
    closeLandmarker(previous);

    try {
      const vision = await loadVisionModule();
      const landmarker = await vision.HandLandmarker.createFromOptions(
        this.#fileset,
        this.#buildLandmarkerOptions('CPU'),
      );
      if (!this.#running) {
        closeLandmarker(landmarker);
        return false;
      }
      this.#landmarker = landmarker;
      this.#delegate = 'CPU';
      return true;
    } catch {
      return false;
    }
  }

  #onDetectionFailure(error) {
    this.#consecutiveFailures += 1;
    if (this.#consecutiveFailures < MAX_CONSECUTIVE_DETECTION_FAILURES) return;
    this.#fatalFailure(
      createTrackerError(
        'CAMERA_FAILED',
        {
          title: '手部识别中断',
          message: '手部识别连续失败，已停止摄像头。',
          hint: '请重试；也可以先进入演示模式。',
        },
        error,
      ),
    );
  }

  /** 不可恢复错误：停止一切资源，广播 error，然后让用户重试 / 进入演示模式。 */
  #fatalFailure(failure) {
    if (!this.#running && !this.#landmarker && !this.#stream) return;
    this.#running = false;
    this.#paused = true;
    this.#stopToken += 1;
    this.#startPromise = null;
    this.#cancelScheduledFrame();
    this.#detachVisibility();
    this.#teardownSession();
    this.#emitStatus('error', failure.message);
    this.#emitError(failure);
  }

  // -------------------------------------------------------------------------
  // 帧数据 / 状态 / 可见性 / 资源清理
  // -------------------------------------------------------------------------

  #nextTimestamp(stamp) {
    const base = Number.isFinite(stamp) ? stamp : nowMs();
    const next = Math.max(this.#lastTimestamp + 1, Math.round(base));
    this.#lastTimestamp = next;
    return next;
  }

  #emitFrame(result, timestampMs) {
    const onFrame = this.#onFrame;
    if (!onFrame) return;

    const video = this.#video;
    const handLandmarks = result && Array.isArray(result.landmarks) ? result.landmarks : [];
    const hands = handLandmarks.map((landmarks, index) => ({
      landmarks,
      handedness: result?.handedness?.[index]?.[0]?.categoryName ?? null,
      confidence: result?.handedness?.[index]?.[0]?.score ?? 0,
    }));
    const landmarks = hands.length > 0 ? hands[0].landmarks : null;

    const handednessEntry = result?.handedness?.[0] ?? result?.handednesses?.[0] ?? null;
    const handInfo = Array.isArray(handednessEntry) ? handednessEntry[0] : handednessEntry;
    const handedness = handInfo && typeof handInfo.categoryName === 'string' ? handInfo.categoryName : null;
    const confidence =
      handInfo && typeof handInfo.score === 'number' && Number.isFinite(handInfo.score) ? handInfo.score : 0;

    const videoWidth = Number.isFinite(video.videoWidth) ? video.videoWidth : 0;
    const videoHeight = Number.isFinite(video.videoHeight) ? video.videoHeight : 0;

    const frame = {
      landmarks,
      hands,
      handedness,
      confidence: landmarks ? confidence : 0,
      videoWidth,
      videoHeight,
      aspect: videoHeight > 0 ? videoWidth / videoHeight : 1,
      timestampMs,
    };

    try {
      onFrame(frame);
    } catch (error) {
      // 消费者（渲染层）单帧异常不应中断追踪；只记录第一次，避免刷屏。
      if (!this.#frameErrorLogged) {
        this.#frameErrorLogged = true;
        console.error('[HandTracker] onFrame 回调抛出异常：', error);
      }
    }
  }

  #emitStatus(phase, message) {
    if (!this.#onStatus) return;
    try {
      this.#onStatus({ phase, message });
    } catch {
      /* UI 回调异常不应中断追踪 */
    }
  }

  #emitError(error) {
    if (!this.#onError) return;
    try {
      this.#onError(error);
    } catch {
      /* UI 回调异常不应中断追踪 */
    }
  }

  #attachVisibility() {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
    if (this.#visibilityHandler) return;
    this.#visibilityHandler = () => {
      if (!this.#running) return;
      if (isDocumentHidden()) {
        this.#paused = true;
        this.#cancelScheduledFrame();
      } else {
        this.#paused = false;
        this.#lastTickAt = 0;
        this.#schedule();
      }
    };
    document.addEventListener('visibilitychange', this.#visibilityHandler);
  }

  #detachVisibility() {
    if (
      this.#visibilityHandler &&
      typeof document !== 'undefined' &&
      typeof document.removeEventListener === 'function'
    ) {
      document.removeEventListener('visibilitychange', this.#visibilityHandler);
    }
    this.#visibilityHandler = null;
  }

  #clearWatchdog() {
    if (this.#watchdogHandle) {
      clearTimeout(this.#watchdogHandle);
      this.#watchdogHandle = 0;
    }
  }

  #cancelScheduledFrame() {
    this.#clearWatchdog();
    if (this.#frameHandle) {
      const video = this.#video;
      if (video && typeof video.cancelVideoFrameCallback === 'function') {
        try {
          video.cancelVideoFrameCallback(this.#frameHandle);
        } catch {
          /* 忽略取消失败 */
        }
      }
      this.#frameHandle = 0;
    }
    if (this.#timerHandle) {
      clearTimeout(this.#timerHandle);
      this.#timerHandle = 0;
    }
  }

  #teardownSession() {
    this.#cancelScheduledFrame();
    this.#detachVisibility();

    const stream = this.#stream;
    this.#stream = null;
    stopStream(stream);

    const video = this.#video;
    if (video) {
      try {
        if (typeof video.pause === 'function') video.pause();
      } catch {
        /* 忽略 pause 失败 */
      }
      try {
        video.srcObject = null;
      } catch {
        /* 忽略 srcObject 赋值失败 */
      }
    }

    const landmarker = this.#landmarker;
    this.#landmarker = null;
    closeLandmarker(landmarker);

    this.#fileset = null;
    this.#detecting = false;
    this.#lastTimestamp = 0;
    this.#lastTickAt = 0;
    this.#consecutiveFailures = 0;
  }

  /** 把任意错误转换成带 code/title/message/hint 的友好错误。 */
  #toFriendlyError(error) {
    if (error && typeof error === 'object' && typeof error.code === 'string' && KNOWN_ERROR_CODES.has(error.code)) {
      return error;
    }
    const description = describeCameraError(error);
    return createTrackerError(description.code, description, error);
  }
}
