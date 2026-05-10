const OmniBox = require("omnibox_sdk");
const runner = require("spider_runner");

/************************** 配置常量（集中管理，便于维护） **************************/
const CONFIG = {
  // 接口配置
  API: {
    HOST: "https://bfzyapi.com",
    VOD: "https://bfzyapi.com/api.php/provide/vod",
    DANMU_API: process.env.DANMU_API || "",
    TIMEOUT: {
      GET: 15000,
      HEAD: 3000,
      SNIFF: 5000
    },
    RETRY: {
      COUNT: 2,        // 请求重试次数
      DELAY_BASE: 300  // 重试基础延迟ms
    }
  },
  // 请求头
  HEADERS: {
    DEFAULT: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
      "Accept": "application/json"
    },
    DANMU: {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    }
  },
  // 播放页规则（基于 HOST 生成，减少硬编码）
  PLAY_URL_PATTERNS: (host) => [
    (vodId) => `${host}/play/${vodId}.html`,
    (vodId) => `${host}/vod/play/${vodId}.html`,
    (vodId) => `${host}/vod/${vodId}.html`,
    (vodId) => `${host}/detail/${vodId}.html`,
    (vodId) => `${host}/movie/${vodId}.html`,
    (vodId) => `${host}/index.php/vod/play/id/${vodId}.html`,
    (vodId) => `${host}/vodplay/${vodId}.html`,
    (vodId) => `${host}/videoplay/${vodId}.html`
  ],
  // 业务常量
  BATCH_SIZE: 20,             // 批量补全详情时的每批数量
  SCRAPE_CONFIDENCE_THRESHOLD: 0.5,
  EPISODE_SORT_FIELDS: ["_seasonNumber", "_episodeNumber"],  // 预留排序字段
  EP_PAD_LENGTH: 2,
  PAGE_SIZE: 20,              // 列表默认每页数量
  SEARCH_PAGE_SIZE: 100,      // 搜索每页数量
  // 缓存配置（全部启用）
  CACHE: {
    PLAY_URL_TTL: 3600000,     // 播放页缓存1小时
    LIST_DATA_TTL: 600000,     // 列表数据缓存10分钟（home/category/search）
    DETAIL_DATA_TTL: 1800000,  // 详情数据缓存30分钟
    CLASS_MAP_TTL: 600000      // 分类映射缓存10分钟
  },
  // 日志配置
  LOG: {
    ENABLE_INFO: false,
    ENABLE_ERROR: true
  },
  // 并发限制
  CONCURRENT_LIMIT: 5,
  // 屏蔽功能开关
  ENABLE_BLOCK_CATEGORY: true,
  BLOCKED_CATEGORY_KEYWORDS: [
    "理论片", "伦理片", "福利", "伦理", "情色", "色情", "成人", "限制级",
    "三级", "****", "激情", "诱惑", "深夜", "19禁"
  ]
};

// 动态生成播放页规则（使用 HOST）
const getPlayUrlPatterns = () => CONFIG.PLAY_URL_PATTERNS(CONFIG.API.HOST);

/************************** 预编译正则 **************************/
const REG_EXP = {
  RESOLUTION: /4[kK]|[xX]26[45]|720[pP]|1080[pP]|2160[pP]/g,
  CODEC: /[hH]\.?26[45]/g,
  MEDIA_TAG: /BluRay|WEB-DL|HDR|REMUX/gi,
  FILE_SUFFIX: /\.mp4|\.mkv|\.avi|\.flv/gi,
  CN_EPISODE: /第\s*([零一二三四五六七八九十0-9]+)\s*[集话章节回期]/,
  SE_EP: /[Ss](?:\d{1,2})?[-._\s]*[Ee](\d{1,3})/i,
  EP_NUM: /\b(?:EP|E)[-._\s]*(\d{1,3})\b/i,
  BRACKET_NUM: /[\[\(【(](\d{1,3})[\]\)】)]/,
  DIRECT_PLAY: /\.(m3u8|mp4|flv|avi|mkv|ts)(?:\?|#|$)/i
};

/************************** 工具函数 **************************/
const CacheUtil = {
  get: (key) => {
    if (!OmniBox?.cache) return null;
    try { return OmniBox.cache.get(key); } catch { return null; }
  },
  set: (key, value, ttl) => {
    if (!OmniBox?.cache) return;
    try { OmniBox.cache.set(key, value, ttl); } catch {}
  },
  // 生成带参数的缓存键
  key: (prefix, params) => `${prefix}_${JSON.stringify(params)}`
};

function safeJsonParse(str, defaultValue = {}) {
  try {
    if (!str) return defaultValue;
    return JSON.parse(str);
  } catch {
    return defaultValue;
  }
}

const MetaCodec = {
  encode: (obj) => {
    try {
      const str = JSON.stringify(obj || {});
      if (typeof Buffer !== "undefined") {
        return Buffer.from(str, "utf8").toString("base64");
      }
      if (typeof btoa === "function") {
        return btoa(unescape(encodeURIComponent(str)));
      }
      return "";
    } catch { return ""; }
  },
  decode: (str) => {
    try {
      if (!str) return null;
      if (typeof Buffer !== "undefined") {
        const raw = Buffer.from(str, "base64").toString("utf8");
        return safeJsonParse(raw, null);
      }
      if (typeof atob === "function") {
        const raw = decodeURIComponent(escape(atob(str)));
        return safeJsonParse(raw, null);
      }
      return null;
    } catch { return null; }
  }
};

function buildUrlWithParams(url, params) {
  if (!params || Object.keys(params).length === 0) return url;
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => searchParams.append(key, value));
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${searchParams.toString()}`;
}

function logInfo(message, data = null) {
  if (!CONFIG.LOG.ENABLE_INFO) return;
  const output = data ? `${message}: ${JSON.stringify(data, null, 2)}` : message;
  OmniBox.log("info", `[优优资源] ${output}`);
}

function logError(message, error) {
  if (!CONFIG.LOG.ENABLE_ERROR) return;
  const errorDetail = error?.stack || error?.message || String(error);
  OmniBox.log("error", `[优优资源] ${message}: ${errorDetail}`);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 增强版 GET 请求（带重试、详细日志）
 */
async function requestGet(url, options = {}) {
  const { params, headers = {}, timeout = CONFIG.API.TIMEOUT.GET } = options;
  const fullUrl = buildUrlWithParams(url, params);
  const finalHeaders = { ...CONFIG.HEADERS.DEFAULT, ...headers };
  let lastError = null;

  for (let attempt = 0; attempt <= CONFIG.API.RETRY.COUNT; attempt++) {
    try {
      const response = await OmniBox.request(fullUrl, {
        method: "GET",
        headers: finalHeaders,
        timeout
      });
      // 状态码非200也算失败（可选，根据业务调整）
      if (response.statusCode !== 200) {
        throw new Error(`HTTP ${response.statusCode}`);
      }
      return {
        status: response.statusCode,
        data: safeJsonParse(response.body)
      };
    } catch (error) {
      lastError = error;
      if (attempt < CONFIG.API.RETRY.COUNT) {
        const waitTime = CONFIG.API.RETRY.DELAY_BASE * (attempt + 1);
        logInfo(`GET请求失败，第${attempt + 1}次重试`, { url: fullUrl, waitTime, error: error.message });
        await delay(waitTime);
      }
    }
  }
  logError(`GET请求最终失败 [${fullUrl}]`, lastError);
  throw lastError;
}

async function requestHead(url, options = {}) {
  const { timeout = CONFIG.API.TIMEOUT.HEAD } = options;
  try {
    const response = await OmniBox.request(url, {
      method: "HEAD",
      headers: CONFIG.HEADERS.DEFAULT,
      timeout
    });
    return { status: response.statusCode };
  } catch (error) {
    logInfo(`HEAD请求失败 [${url}]`, error.message);
    return null;
  }
}

/**
 * 并发探测播放页（代替串行）
 */
async function getPlayPageUrlSmart(vodId) {
  const cacheKey = `playUrl_${vodId}`;
  const cached = CacheUtil.get(cacheKey);
  if (cached) return cached;

  const patterns = getPlayUrlPatterns();
  const testUrls = patterns.map(fn => fn(vodId));
  // 并发探测，设置总超时 5 秒
  const timeoutPromise = delay(5000).then(() => null);
  const racePromises = testUrls.map(async (url) => {
    const headRes = await requestHead(url);
    return headRes?.status === 200 ? url : null;
  });
  const result = await Promise.race([Promise.any(racePromises), timeoutPromise]);
  const finalUrl = result || `${CONFIG.API.HOST}/play/${vodId}.html`;
  CacheUtil.set(cacheKey, finalUrl, CONFIG.CACHE.PLAY_URL_TTL);
  logInfo(`播放页探测结果`, { vodId, finalUrl });
  return finalUrl;
}

function chineseToArabic(cn) {
  const cnNumMap = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  if (!isNaN(Number(cn))) return parseInt(cn, 10);
  if (cn.length === 1) return cnNumMap[cn] || cn;
  if (cn.length === 2) {
    if (cn[0] === "十") return 10 + (cnNumMap[cn[1]] || 0);
    if (cn[1] === "十") return (cnNumMap[cn[0]] || 0) * 10;
  }
  if (cn.length === 3) return (cnNumMap[cn[0]] || 0) * 10 + (cnNumMap[cn[2]] || 0);
  return cn;
}

function extractEpisode(title) {
  if (!title) return "";
  const processedTitle = title
    .replace(REG_EXP.RESOLUTION, " ")
    .replace(REG_EXP.CODEC, " ")
    .replace(REG_EXP.MEDIA_TAG, " ")
    .replace(REG_EXP.FILE_SUFFIX, " ")
    .trim();

  let match = processedTitle.match(REG_EXP.CN_EPISODE);
  if (match) return String(chineseToArabic(match[1]));
  match = processedTitle.match(REG_EXP.SE_EP);
  if (match) return match[1];
  match = processedTitle.match(REG_EXP.EP_NUM);
  if (match) return match[1];
  match = processedTitle.match(REG_EXP.BRACKET_NUM);
  if (match && !["720", "1080", "480"].includes(match[1])) return match[1];
  return "";
}

function isBlockedCategory(categoryName) {
  if (!CONFIG.ENABLE_BLOCK_CATEGORY) return false;
  if (!categoryName) return false;
  const nameLower = categoryName.toLowerCase();
  return CONFIG.BLOCKED_CATEGORY_KEYWORDS.some(keyword =>
    nameLower.includes(keyword.toLowerCase())
  );
}

function filterBlockedVideos(videos) {
  if (!CONFIG.ENABLE_BLOCK_CATEGORY) return videos;
  if (!Array.isArray(videos)) return [];
  return videos.filter(video => {
    const typeName = video.type_name || "";
    if (isBlockedCategory(typeName)) {
      logInfo(`屏蔽视频（分类[${typeName}]）: ${video.vod_name} (${video.vod_id})`);
      return false;
    }
    return true;
  });
}

// 带缓存的分类映射
async function getClassMap() {
  const cacheKey = "classMap";
  const cached = CacheUtil.get(cacheKey);
  if (cached instanceof Map) return cached;

  try {
    const res = await requestGet(CONFIG.API.VOD, { params: { ac: "list", pg: 1, pagesize: 1 } });
    const classList = res.data?.class ?? [];
    const classMap = new Map();
    classList.forEach(cls => {
      const id = String(cls.type_id || "");
      const name = String(cls.type_name || "");
      if (id && name) classMap.set(id, name);
    });
    CacheUtil.set(cacheKey, classMap, CONFIG.CACHE.CLASS_MAP_TTL);
    return classMap;
  } catch (error) {
    logError("获取分类映射失败", error);
    return new Map();
  }
}

function buildDanmuFileName(scrapeData, scrapeType, mapping, fallbackVodName, fallbackEpisodeName) {
  if (!fallbackVodName) return "";
  if (scrapeData) {
    if (scrapeType === "movie") return scrapeData.title || fallbackVodName;
    const title = scrapeData.title || fallbackVodName;
    const seasonAirYear = scrapeData.seasonAirYear || "";
    const seasonNumber = String(mapping?.seasonNumber || 1).padStart(CONFIG.EP_PAD_LENGTH, "0");
    const episodeNumber = String(mapping?.episodeNumber || 1).padStart(CONFIG.EP_PAD_LENGTH, "0");
    return `${title}.${seasonAirYear}.S${seasonNumber}E${episodeNumber}`;
  }
  if (!fallbackEpisodeName || ["正片", "播放"].includes(fallbackEpisodeName)) {
    return fallbackVodName;
  }
  const digits = extractEpisode(fallbackEpisodeName);
  if (digits) {
    const epNum = parseInt(digits, 10);
    if (epNum > 0) {
      return `${fallbackVodName} S01E${epNum.toString().padStart(CONFIG.EP_PAD_LENGTH, "0")}`;
    }
  }
  return fallbackVodName;
}

async function matchDanmu(fileName) {
  const danmuApi = CONFIG.API.DANMU_API;
  if (!danmuApi || !fileName) return [];
  try {
    logInfo(`开始匹配弹幕`, { fileName });
    const matchUrl = `${danmuApi}/api/v2/match`;
    const response = await OmniBox.request(matchUrl, {
      method: "POST",
      headers: CONFIG.HEADERS.DANMU,
      body: JSON.stringify({ fileName }),
      timeout: CONFIG.API.TIMEOUT.GET
    });
    const resData = safeJsonParse(response.body);
    if (response.statusCode !== 200 || !resData.isMatched || !Array.isArray(resData.matches) || resData.matches.length === 0) {
      logInfo(`未匹配到弹幕`, { fileName });
      return [];
    }
    const bestMatch = resData.matches[0];
    if (!bestMatch?.episodeId) return [];
    const danmakuName = [bestMatch.animeTitle, bestMatch.episodeTitle].filter(Boolean).join(" - ") || "弹幕";
    const danmakuURL = `${danmuApi}/api/v2/comment/${bestMatch.episodeId}?format=xml`;
    logInfo(`弹幕匹配成功`, { danmakuName, danmakuURL });
    return [{ name: danmakuName, url: danmakuURL }];
  } catch (error) {
    logError(`弹幕匹配异常`, error);
    return [];
  }
}

/************************** 数据格式化与公共请求 **************************/
function formatVideos(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      return {
        vod_id: String(item.vod_id || ""),
        vod_name: String(item.vod_name || ""),
        vod_pic: String(item.vod_pic || ""),
        type_id: String(item.type_id || ""),
        type_name: String(item.type_name || ""),
        vod_year: String(item.vod_year || ""),
        vod_remarks: String(item.vod_remarks || ""),
        vod_time: String(item.vod_time || ""),
        vod_play_from: String(item.vod_play_from || "default"),
        vod_play_url: String(item.vod_play_url || ""),
        vod_en: String(item.vod_en || "")
      };
    })
    .filter(v => v && v.vod_id);
}

function parsePlaySources(vodItem) {
  const { vod_id, vod_name, vod_play_from, vod_play_url } = vodItem;
  const playSources = [];
  if (vod_play_url) {
    logInfo(`检测到直接播放地址`, { vod_id, urlPreview: vod_play_url.substring(0, 100) });
    const episodes = vod_play_url
      .split("#")
      .map((item, index) => {
        // 兼容没有 $ 的情况，整个作为 URL
        let episodeName, directUrl;
        if (item.includes("$")) {
          [episodeName, directUrl] = item.split("$");
        } else {
          episodeName = `第${index + 1}集`;
          directUrl = item;
        }
        if (!directUrl) return null;
        const fid = `${vod_id}#${index}`;
        const playMeta = {
          sid: vod_id,
          fid,
          v: vod_name,
          e: index + 1,
          url: directUrl,
          isDirect: true
        };
        return {
          name: episodeName,
          playId: `${directUrl}|||${MetaCodec.encode(playMeta)}`,
          _fid: fid,
          _rawName: episodeName,
          _url: directUrl
        };
      })
      .filter(Boolean);
    if (episodes.length > 0) {
      playSources.push({ name: vod_play_from, episodes });
    }
  } else {
    logInfo(`未检测到直接播放地址，使用播放页模式`, { vod_id });
    const fid = `${vod_id}#0`;
    const playMeta = {
      sid: vod_id,
      fid,
      v: vod_name,
      e: 1,
      playFrom: vod_play_from
    };
    playSources.push({
      name: vod_play_from,
      episodes: [{
        name: "正片",
        playId: `need_resolve:${vod_id}|||${MetaCodec.encode(playMeta)}`,
        _fid: fid,
        _rawName: "正片"
      }]
    });
  }
  return playSources;
}

function formatDetailVideos(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const vod = {
        vod_id: String(item.vod_id || ""),
        vod_name: String(item.vod_name || ""),
        vod_pic: String(item.vod_pic || ""),
        type_name: String(item.type_name || ""),
        vod_year: String(item.vod_year || ""),
        vod_area: String(item.vod_area || ""),
        vod_remarks: String(item.vod_remarks || ""),
        vod_actor: String(item.vod_actor || ""),
        vod_director: String(item.vod_director || ""),
        vod_content: String(item.vod_content || "").trim(),
        vod_play_from: String(item.vod_play_from || "default"),
        vod_play_url: String(item.vod_play_url || ""),
        vod_en: String(item.vod_en || "")
      };
      vod.vod_play_sources = parsePlaySources(vod);
      return vod;
    })
    .filter(v => v && v.vod_id);
}

/**
 * 批量补全详情（并发控制）
 */
async function enrichVideosWithDetails(videos) {
  if (!Array.isArray(videos) || videos.length === 0) return videos;
  const needEnrich = videos.filter(v => !v.vod_pic || v.vod_pic === "<nil>" || !v.vod_year || v.vod_year === "<nil>");
  if (needEnrich.length === 0) return videos;
  const videoMap = new Map(needEnrich.map(v => [v.vod_id, v]));
  const videoIDs = Array.from(videoMap.keys());
  logInfo(`开始批量补全视频详情`, { total: videoIDs.length, batchSize: CONFIG.BATCH_SIZE });

  // 并发控制
  const pLimit = (concurrency) => {
    const queue = [];
    let active = 0;
    const next = () => {
      if (active >= concurrency || queue.length === 0) return;
      active++;
      const { task, resolve, reject } = queue.shift();
      task().then(resolve, reject).finally(() => { active--; next(); });
    };
    return (task) => new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      next();
    });
  };
  const limit = pLimit(CONFIG.CONCURRENT_LIMIT);
  const batchTasks = [];
  for (let i = 0; i < videoIDs.length; i += CONFIG.BATCH_SIZE) {
    const batchIDs = videoIDs.slice(i, i + CONFIG.BATCH_SIZE);
    batchTasks.push(limit(async () => {
      try {
        const res = await requestGet(CONFIG.API.VOD, {
          params: { ac: "videolist", ids: batchIDs.join(",") }
        });
        const detailList = Array.isArray(res.data?.list) ? res.data.list : [];
        detailList.forEach(item => {
          const vodId = String(item.vod_id || "");
          const target = videoMap.get(vodId);
          if (!target) return;
          const pic = String(item.vod_pic || "");
          if (pic && pic !== "<nil>") target.vod_pic = pic;
          const year = String(item.vod_year || "");
          if (year && year !== "<nil>") target.vod_year = year;
        });
      } catch (error) {
        logError(`批量补全失败[${Math.floor(i / CONFIG.BATCH_SIZE) + 1}批次]`, error);
      }
    }));
  }
  await Promise.all(batchTasks);
  return videos;
}

function buildScrapedEpisodeName(scrapeData, mapping, originalName) {
  if (!mapping || mapping.episodeNumber === 0 || (mapping.confidence && mapping.confidence < CONFIG.SCRAPE_CONFIDENCE_THRESHOLD)) {
    return originalName;
  }
  if (mapping.episodeName) return mapping.episodeName;
  if (scrapeData && Array.isArray(scrapeData.episodes)) {
    const hit = scrapeData.episodes.find(ep => ep.episodeNumber === mapping.episodeNumber && ep.seasonNumber === mapping.seasonNumber);
    if (hit?.name) return `${hit.episodeNumber}.${hit.name}`;
  }
  return originalName;
}

function handleScrapeData(vod, scrapeData, metadata) {
  if (!scrapeData) return vod;
  if (scrapeData.title) vod.vod_name = scrapeData.title;
  if (scrapeData.poster_path) vod.vod_pic = `https://image.tmdb.org/t/p/w500${scrapeData.poster_path}`;
  if (scrapeData.releaseDate) vod.vod_year = String(scrapeData.releaseDate).substring(0, 4);
  if (scrapeData.overview) vod.vod_content = scrapeData.overview;

  if (scrapeData.credits?.cast) {
    vod.vod_actor = scrapeData.credits.cast.slice(0, 5).map(c => c.name).join(",");
  }
  if (scrapeData.credits?.crew) {
    const directors = scrapeData.credits.crew.filter(c => c.job === "Director").slice(0, 3).map(c => c.name).join(",");
    if (directors) vod.vod_director = directors;
  }

  const videoMappings = metadata.videoMappings || [];
  vod.vod_play_sources.forEach(source => {
    source.episodes.forEach(ep => {
      const meta = ep.playId?.includes("|||") ? MetaCodec.decode(ep.playId.split("|||")[1]) : {};
      const mapping = videoMappings.find(m => m?.fileId === ep._fid || m?.fileId === meta.fid);
      if (mapping) {
        ep.name = buildScrapedEpisodeName(scrapeData, mapping, ep.name);
        ep._seasonNumber = mapping.seasonNumber;
        ep._episodeNumber = mapping.episodeNumber;
      }
    });
    const hasSort = source.episodes.some(ep => ep._seasonNumber ?? ep._episodeNumber);
    if (hasSort) {
      source.episodes.sort((a, b) => {
        const sA = a._seasonNumber || 0, sB = b._seasonNumber || 0;
        if (sA !== sB) return sA - sB;
        return (a._episodeNumber || 0) - (b._episodeNumber || 0);
      });
    }
    source.episodes = source.episodes.map(({ name, playId }) => ({ name, playId }));
  });
  return vod;
}

/************************** 公共列表请求（带缓存） **************************/
async function fetchVodList(params, cacheTTL = CONFIG.CACHE.LIST_DATA_TTL) {
  const cacheKey = CacheUtil.key("vodlist", params);
  const cached = CacheUtil.get(cacheKey);
  if (cached) return cached;

  const res = await requestGet(CONFIG.API.VOD, { params });
  const videos = formatVideos(res.data?.list ?? []);
  const filtered = filterBlockedVideos(videos);
  const enriched = await enrichVideosWithDetails(filtered);
  const result = {
    list: enriched,
    page: params.pg,
    pagecount: res.data?.pagecount ?? 1,
    total: res.data?.total ?? 0
  };
  CacheUtil.set(cacheKey, result, cacheTTL);
  return result;
}

/************************** 核心业务接口 **************************/
async function home(params) {
  logInfo("请求首页数据");
  const result = await fetchVodList({ ac: "list", pg: 1, pagesize: CONFIG.PAGE_SIZE });
  // 获取分类列表（已屏蔽处理）
  let classes = [];
  try {
    const classMap = await getClassMap();
    classes = Array.from(classMap.entries()).map(([id, name]) => ({ type_id: id, type_name: name }));
    if (CONFIG.ENABLE_BLOCK_CATEGORY) {
      const originalCount = classes.length;
      classes = classes.filter(cls => !isBlockedCategory(cls.type_name));
      logInfo(`分类过滤: ${originalCount} -> ${classes.length}`);
    }
  } catch (error) {
    logError("获取分类列表失败", error);
  }
  return { list: result.list, class: classes, filters: {} };
}

async function category(params) {
  const categoryId = params.categoryId || "";
  const page = parseInt(params.page) || 1;
  logInfo("请求分类数据", { categoryId, page });

  if (CONFIG.ENABLE_BLOCK_CATEGORY) {
    const classMap = await getClassMap();
    const categoryName = classMap.get(categoryId);
    if (categoryName && isBlockedCategory(categoryName)) {
      logInfo(`分类被屏蔽，返回空数据: ${categoryName} (${categoryId})`);
      return { list: [], page, pagecount: 0 };
    }
  }

  const result = await fetchVodList({
    ac: "list",
    t: categoryId,
    pg: page,
    pagesize: CONFIG.PAGE_SIZE
  });
  return { list: result.list, page: result.page, pagecount: result.pagecount };
}

async function search(params) {
  const keyword = params.keyword || params.wd || "";
  const page = parseInt(params.page) || 1;
  logInfo("请求搜索数据", { keyword, page });
  const result = await fetchVodList({
    ac: "list",
    wd: keyword,
    pg: page,
    pagesize: CONFIG.SEARCH_PAGE_SIZE
  });
  return {
    list: result.list,
    page: result.page,
    pagecount: result.pagecount,
    total: result.total
  };
}

async function detail(params, context) {
  const videoId = params.videoId;
  if (!videoId) {
    logInfo("详情请求缺少videoId");
    return { list: [] };
  }
  const cacheKey = CacheUtil.key("detail", { videoId });
  const cached = CacheUtil.get(cacheKey);
  if (cached) return cached;

  logInfo("请求视频详情", { videoId });
  try {
    const res = await requestGet(CONFIG.API.VOD, { params: { ac: "videolist", ids: videoId } });
    let videos = formatDetailVideos(res.data?.list ?? []);
    if (videos.length === 0) return { list: [] };
    let vod = videos[0];

    if (CONFIG.ENABLE_BLOCK_CATEGORY && vod.type_name && isBlockedCategory(vod.type_name)) {
      logInfo(`详情视频分类被屏蔽，忽略: ${vod.vod_name} (${vod.type_name})`);
      return { list: [] };
    }

    // 构建刮削候选
    const sourceCandidates = [];
    vod.vod_play_sources.forEach(source => {
      source.episodes.forEach(ep => {
        const meta = ep.playId?.includes("|||") ? MetaCodec.decode(ep.playId.split("|||")[1]) : {};
        const fid = ep._fid || meta.fid;
        if (fid) {
          sourceCandidates.push({ fid, file_id: fid, file_name: ep._rawName, name: ep.name, format_type: "video" });
        }
      });
    });

    let metadata = null;
    if (sourceCandidates.length > 0 && vod.vod_name) {
      const sourceId = `spider_source_${context.sourceId}_${videoId}`;
      await OmniBox.processScraping(sourceId, vod.vod_name, vod.vod_name, sourceCandidates);
      metadata = await OmniBox.getScrapeMetadata(sourceId);
      if (metadata?.scrapeData) {
        vod = handleScrapeData(vod, metadata.scrapeData, metadata);
        logInfo("刮削处理完成", { title: metadata.scrapeData.title });
      }
    }
    // 将 metadata 挂载到 vod 上供 play 使用（避免重复请求）
    vod._scrapeMetadata = metadata;
    CacheUtil.set(cacheKey, { list: [vod] }, CONFIG.CACHE.DETAIL_DATA_TTL);
    return { list: [vod] };
  } catch (error) {
    logError("详情请求失败", error);
    return { list: [] };
  }
}

async function play(params, context) {
  const rawPlayId = params.playId || "";
  const flag = params.flag || "";
  const vodId = params.vodId || "";
  logInfo("处理播放请求", { rawPlayId, flag, vodId });

  let playUrl = rawPlayId;
  let vodName = "";
  let episodeName = "";
  let isDirectAddress = false;
  let metadata = null;

  if (rawPlayId.includes("|||")) {
    const [mainId, metaB64] = rawPlayId.split("|||");
    const meta = MetaCodec.decode(metaB64);
    vodName = meta?.v || "";
    episodeName = meta?.e || "";
    isDirectAddress = meta?.isDirect || false;

    if (isDirectAddress) {
      playUrl = mainId;
    } else if (mainId.startsWith("need_resolve:")) {
      const resolveId = mainId.split(":")[1] || meta?.sid;
      if (resolveId) playUrl = await getPlayPageUrlSmart(resolveId);
    } else {
      playUrl = mainId;
    }
  }

  // 尝试获取缓存的刮削元数据（从 detail 中已获取）
  if (vodId && context?.sourceId) {
    try {
      const detailCacheKey = CacheUtil.key("detail", { videoId: vodId });
      const detailCached = CacheUtil.get(detailCacheKey);
      if (detailCached?.list?.[0]?._scrapeMetadata) {
        metadata = detailCached.list[0]._scrapeMetadata;
      } else {
        // 降级：直接请求
        const sourceId = `spider_source_${context.sourceId}_${vodId}`;
        metadata = await OmniBox.getScrapeMetadata(sourceId);
      }
    } catch (err) {
      logError("获取刮削元数据失败", err);
    }
  }

  let danmuFileName = "";
  if (vodId && metadata?.scrapeData) {
    const meta = rawPlayId.includes("|||") ? MetaCodec.decode(rawPlayId.split("|||")[1]) : {};
    const mapping = (metadata.videoMappings || []).find(m => m?.fileId === meta?.fid);
    danmuFileName = buildDanmuFileName(metadata.scrapeData, metadata.scrapeType, mapping, vodName, episodeName);
    vodName = metadata.scrapeData.title || vodName;
  }

  // 解析播放地址
  let resolvedUrl = playUrl;
  let resolvedHeader = {};
  let parse = 1;

  if (REG_EXP.DIRECT_PLAY.test(playUrl) || isDirectAddress) {
    parse = 0;
    logInfo("直接播放地址");
  } else if (/^https?:\/\//i.test(playUrl)) {
    try {
      const sniffRes = await OmniBox.sniffVideo(playUrl, { timeout: CONFIG.API.TIMEOUT.SNIFF });
      if (sniffRes?.url) {
        resolvedUrl = sniffRes.url;
        resolvedHeader = sniffRes.header || {};
        parse = 0;
        logInfo("视频嗅探成功");
      } else {
        logInfo("视频嗅探无结果，使用原始地址");
      }
    } catch (err) {
      logError("视频嗅探失败", err);
    }
  }

  const playRes = {
    urls: [{ name: "默认线路", url: resolvedUrl }],
    flag,
    header: resolvedHeader,
    parse
  };

  if (CONFIG.API.DANMU_API) {
    danmuFileName = danmuFileName || buildDanmuFileName(null, "", null, vodName, episodeName);
    if (danmuFileName) {
      const danList = await matchDanmu(danmuFileName);
      if (danList.length) playRes.danmaku = danList;
    }
  }
  return playRes;
}

/************************** 启动 **************************/
async function bootstrap() {
  try {
    // 依赖检查
    if (typeof OmniBox === "undefined" || typeof runner === "undefined") {
      throw new Error("缺少必要的全局依赖：OmniBox 或 runner");
    }
    const exports = { home, category, search, detail, play };
    runner.run(exports);
    logInfo("优优资源爬虫脚本启动成功");
  } catch (error) {
    logError("脚本全局启动异常", error);
  }
}

bootstrap();