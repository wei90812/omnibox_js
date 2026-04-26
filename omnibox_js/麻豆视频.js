const OmniBox = require("omnibox_sdk");
const runner = require("spider_runner");

/************************** 配置常量（集中管理，便于维护） **************************/
const CONFIG = {
  // 接口配置
  API: {
    HOST: "https://91md.me",
    VOD: "https://91md.me/api.php/provide/vod",
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
  // 播放页规则
  PLAY_URL_PATTERNS: [
    (vodId) => `${CONFIG.API.HOST}/play/${vodId}.html`,
    (vodId) => `${CONFIG.API.HOST}/vod/play/${vodId}.html`,
    (vodId) => `${CONFIG.API.HOST}/vod/${vodId}.html`,
    (vodId) => `${CONFIG.API.HOST}/detail/${vodId}.html`,
    (vodId) => `${CONFIG.API.HOST}/movie/${vodId}.html`,
    (vodId) => `${CONFIG.API.HOST}/index.php/vod/play/id/${vodId}.html`,
    (vodId) => `${CONFIG.API.HOST}/vodplay/${vodId}.html`,
    (vodId) => `${CONFIG.API.HOST}/videoplay/${vodId}.html`
  ],
  // 业务常量
  BATCH_SIZE: 20,
  SCRAPE_CONFIDENCE_THRESHOLD: 0.5,
  EPISODE_SORT_FIELDS: ["_seasonNumber", "_episodeNumber"],
  EP_PAD_LENGTH: 2,
  // 缓存配置
  CACHE: {
    PLAY_URL_TTL: 3600000, // 播放页缓存1小时
    LIST_DATA_TTL: 600000, // 列表缓存10分钟
    DETAIL_DATA_TTL: 1800000
  },
  // 日志配置
  LOG: {
    ENABLE_INFO: false,
    ENABLE_ERROR: true
  },
  // 并发限制
  CONCURRENT_LIMIT: 5
};

/************************** 预编译正则（全局复用，提升性能） **************************/
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

/************************** 基础工具类 **************************/
/**
 * 缓存工具 - 兼容无缓存SDK降级
 */
const CacheUtil = {
  get: (key) => {
    if (!OmniBox?.cache) return null;
    try { return OmniBox.cache.get(key); } catch { return null; }
  },
  set: (key, value, ttl) => {
    if (!OmniBox?.cache) return;
    try { OmniBox.cache.set(key, value, ttl); } catch {}
  }
};

/**
 * 安全JSON解析
 * @param {string} str 字符串
 * @param {any} defaultValue 兜底值
 * @returns {any} 解析结果
 */
function safeJsonParse(str, defaultValue = {}) {
  try {
    if (!str) return defaultValue;
    return JSON.parse(str);
  } catch {
    return defaultValue;
  }
}

/**
 * 通用Base64编解码 - 兼容非Node环境
 */
const MetaCodec = {
  encode: (obj) => {
    try {
      const str = JSON.stringify(obj || {});
      if (typeof Buffer !== "undefined") {
        return Buffer.from(str, "utf8").toString("base64");
      }
      return btoa(unescape(encodeURIComponent(str)));
    } catch (_) {
      return "";
    }
  },
  decode: (str) => {
    try {
      if (!str) return null;
      if (typeof Buffer !== "undefined") {
        const raw = Buffer.from(str, "base64").toString("utf8");
        return safeJsonParse(raw, null);
      }
      const raw = decodeURIComponent(escape(atob(str)));
      return safeJsonParse(raw, null);
    } catch (_) {
      return null;
    }
  }
};

/**
 * 构建带参数URL
 */
function buildUrlWithParams(url, params) {
  if (!params || Object.keys(params).length === 0) return url;
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => searchParams.append(key, value));
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${searchParams.toString()}`;
}

/************************** 日志工具（分级+开关） **************************/
function logInfo(message, data = null) {
  if (!CONFIG.LOG.ENABLE_INFO) return;
  const output = data ? `${message}: ${JSON.stringify(data, null, 2)}` : message;
  OmniBox.log("info", `[麻豆视频] ${output}`);
}

function logError(message, error) {
  if (!CONFIG.LOG.ENABLE_ERROR) return;
  const errorDetail = error?.stack || error?.message || String(error);
  OmniBox.log("error", `[麻豆视频] ${message}: ${errorDetail}`);
}

/************************** 通用请求封装（统一重试、超时、异常） **************************/
/**
 * 延迟函数
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 基础GET请求（带重试）
 */
async function requestGet(url, options = {}) {
  const { params, headers = {}, timeout = CONFIG.API.TIMEOUT.GET } = options;
  const fullUrl = buildUrlWithParams(url, params);
  const finalHeaders = { ...CONFIG.HEADERS.DEFAULT, ...headers };
  let retryCount = 0;

  while (retryCount <= CONFIG.API.RETRY.COUNT) {
    try {
      const response = await OmniBox.request(fullUrl, {
        method: "GET",
        headers: finalHeaders,
        timeout
      });
      return {
        status: response.statusCode || 0,
        data: safeJsonParse(response.body)
      };
    } catch (error) {
      retryCount++;
      if (retryCount > CONFIG.API.RETRY.COUNT) {
        logError(`GET请求最终失败 [${fullUrl}]`, error);
        throw error;
      }
      const waitTime = CONFIG.API.RETRY.DELAY_BASE * retryCount;
      logInfo(`GET请求失败，准备第${retryCount}次重试`, { url: fullUrl, waitTime });
      await delay(waitTime);
    }
  }
}

/**
 * 基础HEAD请求
 */
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

/************************** 文本处理工具 **************************/
/**
 * 中文数字转阿拉伯数字
 */
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

/**
 * 提取集数
 */
function extractEpisode(title) {
  if (!title) return "";
  const processedTitle = title
    .replace(REG_EXP.RESOLUTION, " ")
    .replace(REG_EXP.CODEC, " ")
    .replace(REG_EXP.MEDIA_TAG, " ")
    .replace(REG_EXP.FILE_SUFFIX, " ")
    .trim();

  const cnMatch = processedTitle.match(REG_EXP.CN_EPISODE);
  if (cnMatch) return String(chineseToArabic(cnMatch[1]));

  const seMatch = processedTitle.match(REG_EXP.SE_EP);
  if (seMatch) return seMatch[1];

  const epMatch = processedTitle.match(REG_EXP.EP_NUM);
  if (epMatch) return epMatch[1];

  const bracketMatch = processedTitle.match(REG_EXP.BRACKET_NUM);
  if (bracketMatch && !["720", "1080", "480"].includes(bracketMatch[1])) {
    return bracketMatch[1];
  }
  return "";
}

/************************** 业务工具函数 **************************/
/**
 * 构建弹幕文件名
 */
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

/**
 * 弹幕匹配
 */
async function matchDanmu(fileName) {
  const danmuApi = CONFIG.API.DANMU_API;
  if (!danmuApi || !fileName) return [];
  try {
    logInfo(`开始匹配弹幕`, { fileName });
    const matchUrl = `${danmuApi}/api/v2/match`;
    const response = await OmniBox.request(matchUrl, {
      method: "POST",
      headers: CONFIG.HEADERS.DANMU,
      body: JSON.stringify({ fileName })
    });
    const resData = safeJsonParse(response.body);
    if (response.statusCode !== 200 || !resData.isMatched || !Array.isArray(resData.matches) || resData.matches.length === 0) {
      logInfo(`未匹配到弹幕`, { fileName });
      return [];
    }
    // 择优匹配
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

/**
 * 格式化基础视频列表
 */
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

/**
 * 解析播放源
 */
function parsePlaySources(vodItem) {
  const { vod_id, vod_name, vod_play_from, vod_play_url } = vodItem;
  const playSources = [];
  if (vod_play_url) {
    logInfo(`检测到直接播放地址`, { vod_id, urlPreview: vod_play_url.substring(0, 100) });
    const episodes = vod_play_url
      .split("#")
      .map((item, index) => {
        const [episodeName = `第${index + 1}集`, directUrl = ""] = item.split("$");
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

/**
 * 格式化详情视频
 */
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
 * 批量补全封面/年份（分批+异常隔离）
 */
async function enrichVideosWithDetails(videos) {
  if (!Array.isArray(videos) || videos.length === 0) return videos;
  const needEnrich = videos.filter(v => !v.vod_pic || v.vod_pic === "<nil>");
  if (needEnrich.length === 0) return videos;
  const videoMap = new Map(needEnrich.map(v => [v.vod_id, v]));
  const videoIDs = Array.from(videoMap.keys());
  logInfo(`开始批量补全视频详情`, { total: videoIDs.length, batchSize: CONFIG.BATCH_SIZE });

  for (let i = 0; i < videoIDs.length; i += CONFIG.BATCH_SIZE) {
    const batchIDs = videoIDs.slice(i, i + CONFIG.BATCH_SIZE);
    try {
      const res = await requestGet(CONFIG.API.VOD, {
        params: { ac: "videolist", ids: batchIDs.join(",") }
      });
      const detailList = Array.isArray(res.data.list) ? res.data.list : [];
      detailList.forEach(item => {
        const vodId = String(item.vod_id || "");
        const target = videoMap.get(vodId);
        if (!target) return;
        // 增量覆盖，非空才替换
        const pic = String(item.vod_pic || "");
        if (pic && pic !== "<nil>") target.vod_pic = pic;
        const year = String(item.vod_year || "");
        if (year && year !== "<nil>") target.vod_year = year;
      });
    } catch (error) {
      logError(`批量补全失败[${Math.floor(i / CONFIG.BATCH_SIZE) + 1}批次]`, error);
    }
  }
  return videos;
}

/**
 * 智能获取播放页（缓存优先）
 */
async function getPlayPageUrlSmart(vodId) {
  const cacheKey = `playUrl_${vodId}`;
  const cached = CacheUtil.get(cacheKey);
  if (cached) return cached;

  for (const pattern of CONFIG.PLAY_URL_PATTERNS) {
    const testUrl = pattern(vodId);
    logInfo(`探测播放页`, { vodId, testUrl });
    const headRes = await requestHead(testUrl);
    if (headRes?.status === 200) {
      CacheUtil.set(cacheKey, testUrl, CONFIG.CACHE.PLAY_URL_TTL);
      return testUrl;
    }
  }
  const fallbackUrl = `${CONFIG.API.HOST}/play/${vodId}.html`;
  CacheUtil.set(cacheKey, fallbackUrl, CONFIG.CACHE.PLAY_URL_TTL);
  logInfo(`使用兜底播放页`, { vodId, fallbackUrl });
  return fallbackUrl;
}

/**
 * 构建刮削后剧集名
 */
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

/************************** 详情页拆分工具 **************************/
/**
 * 处理刮削数据增量覆盖
 */
function handleScrapeData(vod, scrapeData, metadata) {
  if (!scrapeData) return vod;
  // 增量赋值，不强制覆盖
  if (scrapeData.title) vod.vod_name = scrapeData.title;
  if (scrapeData.poster_path) vod.vod_pic = `https://image.tmdb.org/t/p/w500${scrapeData.poster_path}`;
  if (scrapeData.releaseDate) vod.vod_year = String(scrapeData.releaseDate).substring(0, 4);
  if (scrapeData.overview) vod.vod_content = scrapeData.overview;

  // 演员导演
  if (scrapeData.credits?.cast) {
    vod.vod_actor = scrapeData.credits.cast.slice(0, 5).map(c => c.name).join(",");
  }
  if (scrapeData.credits?.crew) {
    const directors = scrapeData.credits.crew.filter(c => c.job === "Director").slice(0, 3).map(c => c.name).join(",");
    if (directors) vod.vod_director = directors;
  }

  // 剧集处理
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
    // 剧集排序
    const hasSort = source.episodes.some(ep => ep._seasonNumber ?? ep._episodeNumber);
    if (hasSort) {
      source.episodes.sort((a, b) => {
        const sA = a._seasonNumber || 0, sB = b._seasonNumber || 0;
        if (sA !== sB) return sA - sB;
        return (a._episodeNumber || 0) - (b._episodeNumber || 0);
      });
    }
    // 清理冗余字段
    source.episodes = source.episodes.map(({ name, playId }) => ({ name, playId }));
  });
  return vod;
}

/************************** 核心业务接口 **************************/
async function home(params) {
  logInfo("请求首页数据");
  try {
    const res = await requestGet(CONFIG.API.VOD, { params: { ac: "list", pg: 1, pagesize: 20 } });
    let videos = formatVideos(res.data.list || []);
    videos = await enrichVideosWithDetails(videos);
    const classes = (res.data.class || []).map(item => ({
      type_id: String(item.type_id),
      type_name: item.type_name
    }));
    logInfo(`首页加载完成`, { videoCount: videos.length, classCount: classes.length });
    return { list: videos, class: classes, filters: {} };
  } catch (error) {
    logError("首页请求失败", error);
    return { list: [], class: [], filters: {} };
  }
}

async function category(params) {
  const categoryId = params.categoryId || "";
  const page = parseInt(params.page) || 1;
  logInfo("请求分类数据", { categoryId, page });
  try {
    const res = await requestGet(CONFIG.API.VOD, {
      params: { ac: "list", t: categoryId, pg: page, pagesize: 20 }
    });
    let videos = formatVideos(res.data.list || []);
    videos = await enrichVideosWithDetails(videos);
    return { list: videos, page, pagecount: res.data.pagecount || 1 };
  } catch (error) {
    logError("分类请求失败", error);
    return { list: [], page, pagecount: 0 };
  }
}

async function search(params) {
  const keyword = params.keyword || params.wd || "";
  const page = parseInt(params.page) || 1;
  logInfo("请求搜索数据", { keyword, page });
  try {
    const res = await requestGet(CONFIG.API.VOD, {
      params: { ac: "list", wd: keyword, pg: page, pagesize: 100 }
    });
    let videos = formatVideos(res.data.list || []);
    videos = await enrichVideosWithDetails(videos);
    return {
      list: videos,
      page,
      pagecount: res.data.pagecount || 1,
      total: res.data.total || 0
    };
  } catch (error) {
    logError("搜索请求失败", error);
    return { list: [], page, pagecount: 0, total: 0 };
  }
}

async function detail(params, context) {
  const videoId = params.videoId;
  if (!videoId) {
    logInfo("详情请求缺少videoId");
    return { list: [] };
  }
  logInfo("请求视频详情", { videoId });
  try {
    const res = await requestGet(CONFIG.API.VOD, { params: { ac: "videolist", ids: videoId } });
    let videos = formatDetailVideos(res.data.list || []);
    if (videos.length === 0) return { list: [] };
    let vod = videos[0];

    // 刮削处理
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

    if (sourceCandidates.length > 0 && vod.vod_name) {
      const sourceId = `spider_source_${context.sourceId}_${videoId}`;
      await OmniBox.processScraping(sourceId, vod.vod_name, vod.vod_name, sourceCandidates);
      const metadata = await OmniBox.getScrapeMetadata(sourceId);
      if (metadata?.scrapeData) {
        vod = handleScrapeData(vod, metadata.scrapeData, metadata);
        logInfo("刮削处理完成", { title: metadata.scrapeData.title });
      }
    }
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

  // 弹幕文件名
  let danmuFileName = "";
  if (vodId) {
    try {
      const sourceId = `spider_source_${context.sourceId}_${vodId}`;
      const metadata = await OmniBox.getScrapeMetadata(sourceId);
      if (metadata?.scrapeData) {
        const meta = rawPlayId.includes("|||") ? MetaCodec.decode(rawPlayId.split("|||")[1]) : {};
        const mapping = (metadata.videoMappings || []).find(m => m?.fileId === meta?.fid);
        danmuFileName = buildDanmuFileName(metadata.scrapeData, metadata.scrapeType, mapping, vodName, episodeName);
        vodName = metadata.scrapeData.title || vodName;
      }
    } catch (err) {
      logError("弹幕文件名构建失败", err);
    }
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
      }
    } catch (err) {
      logError("视频嗅探失败", err);
    }
  }

  // 组装返回
  const playRes = {
    urls: [{ name: "默认线路", url: resolvedUrl }],
    flag,
    header: resolvedHeader,
    parse
  };

  // 挂载弹幕
  if (CONFIG.API.DANMU_API) {
    danmuFileName = danmuFileName || buildDanmuFileName(null, "", null, vodName, episodeName);
    if (danmuFileName) {
      const danList = await matchDanmu(danmuFileName);
      if (danList.length) playRes.danmaku = danList;
    }
  }
  return playRes;
}

/************************** 全局异常捕获 & 导出运行 **************************/
async function bootstrap() {
  try {
    const exports = { home, category, search, detail, play };
    runner.run(exports);
    logInfo("麻豆视频爬虫脚本启动成功");
  } catch (error) {
    logError("脚本全局启动异常", error);
  }
}

bootstrap();