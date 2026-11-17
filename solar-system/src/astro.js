/**
 * 太阳系 · 粒子天文台 — 开普勒轨道数学
 * Solar System Particle Observatory — Keplerian orbital math
 *
 * 纯函数模块：不触碰 DOM、不依赖 three.js，浏览器与 Node 测试均可直接引入。
 *
 * 约定（见 docs/CONTRACT.md 第 3 节）：
 * - 历元 J2000.0 = 2000-01-01 12:00 UTC（毫秒时间戳 J2000_MS）；
 * - 时间以儒略世纪（36,525 天）计，轨道根数按 Standish 表线性外推；
 * - 黄道直角坐标：x-y 为黄道面，z 垂直黄道面，单位 AU；
 * - 轨道根数中 a 用 AU、e 无量纲、i 用弧度，L/peri/node 保持度（与 data.js 一致）；
 * - 开普勒方程用牛顿迭代求解（至少 8 次或收敛）。
 */

/** J2000.0 历元：2000-01-01T12:00:00Z 的毫秒时间戳（946728000000）。 */
export const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);

const DAY_MS = 86_400_000;
const JULIAN_CENTURY_DAYS = 36_525;
const TAU = Math.PI * 2;
const DEG_TO_RAD = Math.PI / 180;

const ZERO_RATES = Object.freeze({
  semiMajorAU: 0,
  eccentricity: 0,
  inclinationDeg: 0,
  meanLongitudeDeg: 0,
  perihelionLongDeg: 0,
  nodeLongDeg: 0,
});

/** 将 Date 或毫秒时间戳统一为 Date；非法输入返回 Invalid Date。 */
function toDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value);
  return new Date(NaN);
}

/** 把角度归一化到 [0, 2π)。NaN 原样返回 NaN。 */
function normalizeRadians(angle) {
  if (!Number.isFinite(angle)) return NaN;
  const wrapped = angle % TAU;
  return wrapped < 0 ? wrapped + TAU : wrapped;
}

/**
 * 计算给定日期距 J2000.0 的儒略世纪数（可为负）。
 * @param {Date|number} date
 * @returns {number}
 */
export function centuriesSinceJ2000(date) {
  const value = toDate(date);
  const time = value.getTime();
  if (!Number.isFinite(time)) return NaN;
  return (time - J2000_MS) / (DAY_MS * JULIAN_CENTURY_DAYS);
}

/**
 * 某一时刻的瞬时轨道根数（线性外推）。
 * @param {object} planet data.js 中的行星数据
 * @param {Date|number} date
 * @returns {{a:number, e:number, i:number, L:number, peri:number, node:number}}
 *   a: AU；e: 无量纲；i: 弧度；L/peri/node: 度（J2000 黄道经度）。
 */
export function elementsAt(planet, date) {
  if (!planet || typeof planet !== 'object') {
    throw new TypeError('elementsAt(planet, date) 需要一个行星数据对象');
  }
  const rates = planet.rates ?? ZERO_RATES;
  const centuries = centuriesSinceJ2000(date);

  const a = planet.semiMajorAU + (rates.semiMajorAU ?? 0) * centuries;
  const e = planet.eccentricity + (rates.eccentricity ?? 0) * centuries;
  const inclinationDeg = planet.inclinationDeg + (rates.inclinationDeg ?? 0) * centuries;
  const L = planet.meanLongitudeDeg + (rates.meanLongitudeDeg ?? 0) * centuries;
  const peri = planet.perihelionLongDeg + (rates.perihelionLongDeg ?? 0) * centuries;
  const node = planet.nodeLongDeg + (rates.nodeLongDeg ?? 0) * centuries;

  return { a, e, i: inclinationDeg * DEG_TO_RAD, L, peri, node };
}

/**
 * 平近点角 M = L - peri，归一化到 [0, 2π)。
 * @param {object} planet
 * @param {Date|number} date
 * @returns {number} 弧度
 */
export function meanAnomalyAt(planet, date) {
  const elements = elementsAt(planet, date);
  return normalizeRadians((elements.L - elements.peri) * DEG_TO_RAD);
}

/**
 * 牛顿迭代解 Kepler 方程 E - e·sinE = M。
 * 初始猜测 E₀ = M + e·sinM；每次迭代 E ← E - f(E)/f'(E)；
 * 至少执行 8 次迭代，或步长 < 1e-12 后收敛；返回 [0, 2π) 内的偏近点角。
 * @param {number} M 平近点角（弧度，可不在 [0, 2π)）
 * @param {number} e 偏心率（0 ≤ e < 1）
 * @returns {number} 偏近点角 E（弧度，[0, 2π)）
 */
export function solveKepler(M, e) {
  const meanAnomaly = normalizeRadians(Number(M));
  if (!Number.isFinite(meanAnomaly)) return NaN;

  const eccentricity = Number.isFinite(e) ? Math.min(0.999999, Math.max(0, e)) : 0;
  if (eccentricity === 0) return meanAnomaly;

  let eccentricAnomaly = meanAnomaly + eccentricity * Math.sin(meanAnomaly);
  for (let iteration = 0; iteration < 24; iteration += 1) {
    const residual = eccentricAnomaly - eccentricity * Math.sin(eccentricAnomaly) - meanAnomaly;
    const derivative = 1 - eccentricity * Math.cos(eccentricAnomaly);
    const step = residual / derivative;
    eccentricAnomaly -= step;
    if (iteration >= 7 && Math.abs(step) < 1e-12) break;
  }
  return normalizeRadians(eccentricAnomaly);
}

/**
 * 由偏近点角求黄道直角坐标（AU）。
 * r = a(1 - e·cosE)；真近点角 ν = atan2(√(1-e²)·sinE, cosE - e)；
 * 经 ω = peri - node、i、node 三次旋转到黄道坐标系。
 */
function pointFromEccentricAnomaly(elements, eccentricAnomaly) {
  const { a, e, i, peri, node } = elements;
  const cosE = Math.cos(eccentricAnomaly);
  const sinE = Math.sin(eccentricAnomaly);

  const radius = a * (1 - e * cosE);
  const trueAnomaly = Math.atan2(Math.sqrt(Math.max(0, 1 - e * e)) * sinE, cosE - e);

  const argumentOfPerihelion = (peri - node) * DEG_TO_RAD;
  const ascendingNode = node * DEG_TO_RAD;
  const u = argumentOfPerihelion + trueAnomaly;

  const cosU = Math.cos(u);
  const sinU = Math.sin(u);
  const cosNode = Math.cos(ascendingNode);
  const sinNode = Math.sin(ascendingNode);
  const cosInc = Math.cos(i);
  const sinInc = Math.sin(i);

  return {
    x: radius * (cosNode * cosU - sinNode * sinU * cosInc),
    y: radius * (sinNode * cosU + cosNode * sinU * cosInc),
    z: radius * sinU * sinInc,
  };
}

/**
 * 行星在给定时刻的日心黄道坐标（AU）。
 * @param {object} planet
 * @param {Date|number} date
 * @returns {{x:number, y:number, z:number}}
 */
export function orbitalPositionAU(planet, date) {
  const elements = elementsAt(planet, date);
  const meanAnomaly = normalizeRadians((elements.L - elements.peri) * DEG_TO_RAD);
  const eccentricAnomaly = solveKepler(meanAnomaly, elements.e);
  return pointFromEccentricAnomaly(elements, eccentricAnomaly);
}

/**
 * 采样一整圈闭合轨道（用于粒子轨道线）。用偏近点角 E 均匀扫描，避免跳变。
 * @param {object} planet
 * @param {Date|number} date 决定轨道根数与起始相位
 * @param {number} [segments=256] 分段数（闭合后点数 = segments + 1）
 * @returns {Array<{x:number, y:number, z:number}>} 首尾同点
 */
export function orbitPathAU(planet, date, segments = 256) {
  const count = Number.isFinite(segments) ? Math.max(3, Math.floor(segments)) : 256;
  const elements = elementsAt(planet, date);
  const meanAnomaly = normalizeRadians((elements.L - elements.peri) * DEG_TO_RAD);
  const startE = solveKepler(meanAnomaly, elements.e);

  const path = [];
  for (let index = 0; index <= count; index += 1) {
    path.push(pointFromEccentricAnomaly(elements, startE + (TAU * index) / count));
  }
  // 精确闭合：末点与首点完全同值，避免浮点误差在渲染时留下缝隙。
  path[count] = { ...path[0] };
  return path;
}

/**
 * 格式化为 UTC 日期字符串 YYYY-MM-DD。
 * @param {Date|number} date
 * @returns {string} 例如 "2026-11-13"；非法日期返回 "—"
 */
export function formatDate(date) {
  const value = toDate(date);
  if (!Number.isFinite(value.getTime())) return '—';
  const year = String(value.getUTCFullYear()).padStart(4, '0');
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const day = String(value.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 格式化日心距（AU）：< 10 AU 保留两位小数，其余保留一位。
 * @param {number} au
 * @returns {string} 例如 "0.39 AU"
 */
export function formatAU(au) {
  const value = Number(au);
  if (!Number.isFinite(value)) return '—';
  return Math.abs(value) >= 10 ? `${value.toFixed(1)} AU` : `${value.toFixed(2)} AU`;
}

/**
 * 格式化天数：< 约 2 年显示「天」，否则换算为「年」。
 * @param {number} days
 * @returns {string} 例如 "88 天"、"11.9 年"
 */
export function formatDays(days) {
  const value = Number(days);
  if (!Number.isFinite(value)) return '—';

  if (Math.abs(value) < 730.5) {
    const rounded = Math.round(value * 10) / 10;
    return `${Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)} 天`;
  }

  const years = Math.round((value / 365.25) * 10) / 10;
  return `${Number.isInteger(years) ? String(years) : years.toFixed(1)} 年`;
}

/**
 * 格式化数字：千分位分组，最多两位小数。
 * @param {number} value
 * @returns {string} 例如 "1,432"；非法值返回 "—"
 */
export function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  try {
    return number.toLocaleString('en-US', {
      maximumFractionDigits: 2,
      useGrouping: true,
    });
  } catch {
    // 极少数无 Intl 环境下的兜底：整数千分位。
    const rounded = Math.round(number * 100) / 100;
    const [integerPart, decimalPart] = String(rounded).split('.');
    const grouped = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return decimalPart ? `${grouped}.${decimalPart}` : grouped;
  }
}
