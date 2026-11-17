/**
 * 月球 — 教学数据与视觉参数。
 *
 * 数值来源：
 * - NASA Moon Fact Sheet — https://nssdc.gsfc.nasa.gov/planetary/factsheet/moonfact.html
 * - NASA Solar System Exploration — Moon
 *
 * 月球不是行星，不进入行星导航、行星循环或“握拳横挥”切换序列。
 * 它只通过地球特写中的点击/捏合进入独立视角。
 */
export const MOON = Object.freeze({
  id: 'moon',
  nameZh: '月球',
  nameEn: 'Moon',
  symbol: '☾',
  type: '天然卫星 · 潮汐锁定',
  kind: 'moon',
  parentId: 'earth',
  radiusKm: 1737.4,
  massKg: 7.342e22,
  densityKgM3: 3344,
  gravityMs2: 1.62,
  escapeKms: 2.38,
  semiMajorAU: 0.00256956,
  orbitalPeriodDays: 27.3217,
  rotationHours: 655.72,
  obliquityDeg: 6.68,
  tempC: -20,
  atmosphere: '几乎无大气（极稀薄外逸层，表压约 3×10⁻¹⁵ bar）',
  moons: 0,
  rings: null,
  albedo: 0.12,
  discovery: '史前已知',
  tagline: '地球唯一的天然卫星，被潮汐锁定，永远以同一面朝向地球。',
  facts: [
    '月球直径 3,474.8 km，约为地球直径的 27%；平均距离地球 384,400 km，光往返约需 2.56 秒。',
    '月球被潮汐锁定：自转周期与公转周期同为 27.32 天，因此从地球永远只能看到约 59% 的月面。',
    '月面重力仅为地球的 1/6（1.62 m/s²），没有大气保温，白天约 127 °C，夜间可降到 -173 °C。',
    '月球正面的暗色月海由古老玄武岩熔岩填充；背面地壳更厚、陨石坑更密集。',
    '月球可能形成于约 45 亿年前一次火星大小天体撞击地球后的碎片盘。',
    '月球正以每年约 3.8 cm 的速度远离地球，地球自转也因此逐渐变慢。',
  ],
  palette: {
    base: '#a8a49a',
    light: '#e2ded2',
    dark: '#4b4944',
    accent: '#d9d4c8',
    atmosphere: '#b9b5aa',
  },
  bands: null,
  spot: null,
});
