// 指纹参数生成：把一个 32 位种子 + 用户选择，转成 fingerprint-chromium 能识别的启动参数。
// 内核本身会用种子去派生 canvas / webgl / 音频 / 字体 / clientRects 等噪声，
// 这里只负责“人能看懂、需要跟代理出口对齐”的那部分：系统、UA、语言、时区、硬件。

const PLATFORMS = {
  windows: {
    label: 'Windows',
    versions: ['10.0.0', '15.0.0', '19.0.0'],
    uaOs: 'Windows NT 10.0; Win64; x64',
    cores: [4, 6, 8, 12, 16],
    memory: [8, 16, 32],
  },
  macos: {
    label: 'macOS',
    versions: ['13.6.0', '14.6.0', '15.3.0', '26.0.0'],
    uaOs: 'Macintosh; Intel Mac OS X 10_15_7',
    cores: [8, 10, 12, 16],
    memory: [8, 16, 32],
  },
  linux: {
    label: 'Linux',
    versions: ['6.5.0', '6.8.0'],
    uaOs: 'X11; Linux x86_64',
    cores: [4, 8, 12, 16],
    memory: [8, 16, 32],
  },
};

const BRANDS = {
  Chrome: ['146.0.7620.71', '147.0.7702.98', '148.0.7778.215'],
  Edge: ['146.0.3506.62', '147.0.3567.51', '148.0.3625.44'],
  Opera: ['122.0.5643.98', '123.0.5698.42'],
  Vivaldi: ['7.6.3800.52'],
};

// 常见真实分辨率，避免出现 1237x811 这种一看就是改过的窗口尺寸
export const SCREEN_PRESETS = [
  { w: 1920, h: 1080, label: '1920×1080 (最常见)' },
  { w: 1536, h: 864, label: '1536×864 (笔记本)' },
  { w: 1440, h: 900, label: '1440×900 (MacBook Air)' },
  { w: 1680, h: 1050, label: '1680×1050' },
  { w: 1366, h: 768, label: '1366×768' },
  { w: 2560, h: 1440, label: '2560×1440' },
];

// 时区 → 语言，用于“跟随代理 IP 自动配指纹”
export const LOCALE_BY_COUNTRY = {
  US: { lang: 'en-US', accept: 'en-US,en', tz: 'America/New_York' },
  GB: { lang: 'en-GB', accept: 'en-GB,en-US,en', tz: 'Europe/London' },
  DE: { lang: 'de-DE', accept: 'de-DE,de,en-US,en', tz: 'Europe/Berlin' },
  FR: { lang: 'fr-FR', accept: 'fr-FR,fr,en-US,en', tz: 'Europe/Paris' },
  ES: { lang: 'es-ES', accept: 'es-ES,es,en-US,en', tz: 'Europe/Madrid' },
  IT: { lang: 'it-IT', accept: 'it-IT,it,en-US,en', tz: 'Europe/Rome' },
  NL: { lang: 'nl-NL', accept: 'nl-NL,nl,en-US,en', tz: 'Europe/Amsterdam' },
  PL: { lang: 'pl-PL', accept: 'pl-PL,pl,en-US,en', tz: 'Europe/Warsaw' },
  CA: { lang: 'en-CA', accept: 'en-CA,en-US,en', tz: 'America/Toronto' },
  AU: { lang: 'en-AU', accept: 'en-AU,en-US,en', tz: 'Australia/Sydney' },
  JP: { lang: 'ja-JP', accept: 'ja-JP,ja,en-US,en', tz: 'Asia/Tokyo' },
  KR: { lang: 'ko-KR', accept: 'ko-KR,ko,en-US,en', tz: 'Asia/Seoul' },
  SG: { lang: 'en-SG', accept: 'en-SG,en-US,en', tz: 'Asia/Singapore' },
  HK: { lang: 'zh-HK', accept: 'zh-HK,zh,en-US,en', tz: 'Asia/Hong_Kong' },
  TW: { lang: 'zh-TW', accept: 'zh-TW,zh,en-US,en', tz: 'Asia/Taipei' },
  MY: { lang: 'ms-MY', accept: 'ms-MY,ms,en-US,en', tz: 'Asia/Kuala_Lumpur' },
  TH: { lang: 'th-TH', accept: 'th-TH,th,en-US,en', tz: 'Asia/Bangkok' },
  VN: { lang: 'vi-VN', accept: 'vi-VN,vi,en-US,en', tz: 'Asia/Ho_Chi_Minh' },
  ID: { lang: 'id-ID', accept: 'id-ID,id,en-US,en', tz: 'Asia/Jakarta' },
  PH: { lang: 'en-PH', accept: 'en-PH,en-US,en', tz: 'Asia/Manila' },
  IN: { lang: 'en-IN', accept: 'en-IN,en-US,en', tz: 'Asia/Kolkata' },
  BR: { lang: 'pt-BR', accept: 'pt-BR,pt,en-US,en', tz: 'America/Sao_Paulo' },
  MX: { lang: 'es-MX', accept: 'es-MX,es,en-US,en', tz: 'America/Mexico_City' },
  AE: { lang: 'ar-AE', accept: 'ar-AE,ar,en-US,en', tz: 'Asia/Dubai' },
  SA: { lang: 'ar-SA', accept: 'ar-SA,ar,en-US,en', tz: 'Asia/Riyadh' },
  TR: { lang: 'tr-TR', accept: 'tr-TR,tr,en-US,en', tz: 'Europe/Istanbul' },
  RU: { lang: 'ru-RU', accept: 'ru-RU,ru,en-US,en', tz: 'Europe/Moscow' },
  CN: { lang: 'zh-CN', accept: 'zh-CN,zh,en-US,en', tz: 'Asia/Shanghai' },
};

export const platformOptions = () =>
  Object.entries(PLATFORMS).map(([key, v]) => ({ key, label: v.label, versions: v.versions }));

export const brandOptions = () =>
  Object.entries(BRANDS).map(([key, versions]) => ({ key, versions }));

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length) % arr.length];

export function randomSeed() {
  // fingerprint-chromium 要的是 32 位整数种子
  return Math.floor(Math.random() * 2147483647) + 1;
}

/**
 * 用种子补全所有没显式指定的指纹字段，保证同一个种子每次开出来完全一致。
 * 传入的字段优先，未传的按种子派生 —— 这样“换一个种子”＝“换一台电脑”。
 */
export function buildFingerprint(input = {}) {
  const seed = Number(input.seed) || randomSeed();
  const rnd = mulberry32(seed);

  const platform = PLATFORMS[input.platform] ? input.platform : pick(rnd, ['windows', 'windows', 'macos']);
  const plat = PLATFORMS[platform];
  const platformVersion = input.platformVersion || pick(rnd, plat.versions);

  const brand = BRANDS[input.brand] ? input.brand : 'Chrome';
  // 默认不指定版本号：内核自己生成的 navigator.userAgent 和 navigator.userAgentData 是一致的，
  // 一旦手动指定，UA 字符串仍是内核真实版本、而 userAgentData 变成指定值，两者对不上反而是破绽。
  const brandVersion = input.brandVersion || '';

  const screen = input.screen && input.screen.w ? input.screen : pick(rnd, SCREEN_PRESETS);

  return {
    seed,
    platform,
    platformVersion,
    brand,
    brandVersion,
    hardwareConcurrency: Number(input.hardwareConcurrency) || pick(rnd, plat.cores),
    deviceMemory: Number(input.deviceMemory) || pick(rnd, plat.memory),
    lang: input.lang || 'en-US',
    acceptLang: input.acceptLang || 'en-US,en',
    timezone: input.timezone || 'America/New_York',
    // 跟随代理 IP：打开前用出口 IP 的国家覆盖 语言/时区
    autoLocale: input.autoLocale !== false,
    webrtc: input.webrtc || 'disabled', // disabled = 只走代理，不泄露真实内网/公网 IP
    screen: { w: screen.w, h: screen.h },
    // 内核没有屏幕参数，不伪装的话 screen.* 会直接暴露这台 Mac 的真实分辨率
    spoofScreen: input.spoofScreen !== false,
    disableSpoofing: Array.isArray(input.disableSpoofing) ? input.disableSpoofing : [],
    customArgs: input.customArgs || '',
  };
}

// 版本号留空时预览用的兜底值，跟随当前打包的内核大版本
const DEFAULT_MAJOR = '148';

/** 展示用的 UA 预览（真实 UA 由内核按同样规则生成，这里只是让人看一眼对不对） */
export function uaPreview(fp) {
  const os = PLATFORMS[fp.platform]?.uaOs || PLATFORMS.windows.uaOs;
  const major = fp.brandVersion ? String(fp.brandVersion).split('.')[0] : DEFAULT_MAJOR;
  const base = `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  if (fp.brand === 'Edge') return `${base} Edg/${major}.0.0.0`;
  if (fp.brand === 'Opera') return `${base} OPR/${major}.0.0.0`;
  if (fp.brand === 'Vivaldi') return `${base} Vivaldi/${major}.0.0.0`;
  return base;
}

/** 把国家码翻成语言/时区，用于代理检测后自动对齐 */
export function localeForCountry(code) {
  return LOCALE_BY_COUNTRY[String(code || '').toUpperCase()] || null;
}
