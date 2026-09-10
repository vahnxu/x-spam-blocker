// ==UserScript==
// @name         X 中文垃圾号识别 / 一键静音·屏蔽 (形态+行为+语义+模板聚类)
// @namespace    https://github.com/vahnxu/x-spam-blocker
// @version      0.7.1
// @description  本地实时识别 X 上的中文色情/引流/搭讪垃圾号。不靠敏感词黑名单（那是军备竞赛），改为综合判据：自动生成 handle 形态 + 随机 emoji 沙拉 + 孤独搭讪语义 + 引流链接 + 「一批号说同一句话」的模板聚类。动作可选静音/屏蔽，带账本与撤销。浏览器本地跑，像广告拦截器一样轻。
// @author       vahnxu
// @homepageURL  https://github.com/vahnxu/x-spam-blocker
// @supportURL   https://github.com/vahnxu/x-spam-blocker/issues
// @updateURL    https://raw.githubusercontent.com/vahnxu/x-spam-blocker/main/x-spam-blocker.user.js
// @downloadURL  https://raw.githubusercontent.com/vahnxu/x-spam-blocker/main/x-spam-blocker.user.js
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ============================================================
  // ① 配置区（普通用户只需要改这里）
  // ============================================================
  //
  // 注意：从 v0.7.0 起，模式 / 动作 / 阈值都可以在右下角面板上点，
  // 并且会存在浏览器本地（localStorage）里，脚本自动更新不会把你的选择冲掉。
  // 下面这些常量只是「你从来没点过面板时的出厂默认值」。

  const VERSION = '0.7.1';

  // 模式：'mark' = 只标红 + 按钮，你点了才动手（默认，最安全）
  //       'auto' = 自动处理命中的号（看顺眼了再在面板上切）
  const DEFAULT_MODE = 'mark';

  // 动作：'block' = 屏蔽（默认——owner 一直这么用，效果在手机端亲眼验证过；会断掉互相关注关系，解除后不自动恢复）
  //       'mute'  = 静音（轻、可撤销、不断关注关系；对未关注账号的回复在会话里是否隐藏只见于 X 文档，未实测）
  const DEFAULT_ACTION = 'block';

  // 命中总分达到这个阈值才算垃圾号（调高更保守、更不易误伤）
  const DEFAULT_THRESHOLD = 5;

  // 「一批号说同一句话」判定：同一会话页里，同一条归一化文本被这么多个**不同账号**说过，就算一个簇
  const CLUSTER_MIN = 3;

  const ACTION_MIN_GAP = 6000;       // 两次写请求最小间隔(ms)，保守慢速，降低账号风控风险
  const ACTION_MAX_GAP = 12000;
  const AUTO_BLOCK_SESSION_CAP = 60; // 单次会话（不刷新页面）最多处理多少个
  const BATCH_BLOCK_CLICK_CAP = 25;  // 每次批量点击最多入队数量，剩下的等下一轮用户确认
  const MAX_TRACKED_HANDLES = 500;   // 只保留最近可见账号的 DOM 引用，避免长时间浏览内存膨胀

  // 尝试次数上限（计**尝试**不计成功，跨刷新有效）。保守工程估计，不是 X 公布的安全阈值。
  const HOURLY_ATTEMPT_CAP = 40;
  const DAILY_ATTEMPT_CAP = 150;

  // 模板指纹簿容量上限
  const TEMPLATE_BUCKET_CAP = 500;   // 每个会话页最多记住多少条模板
  const TEMPLATE_AUTHOR_CAP = 50;    // 每条模板最多记住多少个作者
  const TEMPLATE_GLOBAL_CAP = 2000;  // 全局模板总数上限

  const LEDGER_CAP = 2000;           // 账本最多保留多少条（FIFO 淘汰）
  const REQUEST_TIMEOUT_MS = 20000;  // 单条请求最长等多久；超时即中止并停队（见下方说明）

  // —— 评分权重 —— (见下方 score() 注释)
  const W = {
    handleShape: 3,   // 用户名 = 英文名+一串数字（自动生成号的特征，最硬）
    emojiSalad: 3,    // 随机 emoji 沙拉（多行纯 emoji，或 emoji 很多）—— 绕过去重的行为指纹
    emojiFew: 1,      // 少量 emoji（3~4 个）
    explicit: 4,      // 露骨引流词（命中即基本坐实）
    nameSoft: 2,      // 名字里的软色情/搭讪 token
    bait: 2,          // 孤独/搭讪语义短语
    link: 3,          // 引流链接 / 短域名
    cityBurst: 2,     // 城市名批量堆叠（全国同城引流文案）
    contactCue: 2,    // 点击联系/预约/QQ/TG 等转化提示
    mentionReferral: 5, // 短评 @ 导流：主页/探路/太涩/能打等组合话术
    nameEmoji: 1,     // 名字里带装饰 emoji
    cluster: 3,       // 模板簇：同一句话被 >=CLUSTER_MIN 个不同账号说过（只加标记分，不授权自动出手）
  };

  // 露骨词（出现在名字或正文，命中 +explicit）
  // 末尾几个 sao 系是色情引流号专有词（"sao货 / 线下sao"），普通人极少这样写。
  // 它们同时也在 REFERRAL_CUES 里（短评@导流路径）；放进 EXPLICIT 是为了让"无 @提及"的 sao 帖
  // 也能拿到 +explicit 分（仍低于阈值，需一个旁证才命中，保持保守、不误伤吐槽垃圾号的真人）。
  const EXPLICIT = ['同城上门','上门服务','寻固炮','点击主页','点我主页','日泡平台','真人认证','秒约','可约','空降','外围','楼凤','裸聊','福利姬','涩涩','约炮','约啪','上门约','同城约','加我微信','资源群','线下真实','一对一裸','sao货','sao貨','线下sao','线下骚'];
  // 名字软 token（搭讪/暗示，+nameSoft）
  const NAME_SOFT = ['涩','馋','约见','真实约见','身子','线上','指挥','寻欢','哥哥我要','调教','喂养','榨','骚'];
  // 孤独/搭讪语义短语（不是露骨词，关键词抓不全，这里只列高区分度的，+bait）
  const BAIT = ['想找你','想找人','找人聊','你在吗','谁救我','求靠谱','靠谱朋友','陪我','处对象','两个人更好','把孤独','一起把孤独','约吗','撩我','想脱单','找个人疼','找对象'];
  // 引流链接（+link）
  const LINK_PATTERNS = [/t\.me\//i, /\b[a-z0-9]{2,12}\.(top|xyz|vip|cyou|icu|club|live|cc|shop|fun|link|life)\b/i];
  // 全国城市名堆叠：中文批量垃圾号常用"城市矩阵 + 同城/上门"铺词，普通真人短回复很少这样写。
  const CITY_TERMS = ['北京','上海','广州','深圳','天津','重庆','成都','杭州','南京','苏州','武汉','西安','郑州','长沙','合肥','济南','青岛','宁波','东莞','佛山','无锡','常州','南通','绍兴','贵阳','南宁','石家庄','哈尔滨','长春','厦门','大连','沈阳','福州','太原','温州','南昌','徐州','烟台','潍坊','扬州','洛阳','保定','海口','金华','兰州','乌鲁木齐','临沂','湖州','盐城','唐山','济宁','廊坊','泰州','赣州','呼和浩特','镇江','芜湖','汕头','邯郸','江门','淄博','银川','南阳','淮安','绵阳','连云港','阜阳','新乡','咸阳','三亚','威海','桂林','漳州','遵义','宜昌','宿迁','沧州','衡阳','柳州','襄阳','莆田'];
  const CONTACT_CUES = ['点击即可联系','点击联系','主页联系','私信联系','预约','服务复制','加薇','佳薇','QQ裙','qq群','TG：','TG:', '电报', '大圈品质','附近喝茶','商务接待','学生兼职','同城资源','空姐模特'];
  const REFERRAL_CUES = ['太涩','太色','顶不住','主页能打','她主页','她的主页','能打✈','打✈','打飞机','已探路','探路','花样多','体制内老师','专业牵线','牵线','1-5线覆盖','看主页','sao货','sao貨','线下sao','线下骚','没人比她sao','没人比她骚','沒人比她sao','没有人比她sao'];
  const MENTION_CODE = /@\w+\s+[A-Za-z0-9]{1,3}\b/;

  // 用户名形态：字母开头 + 至少 2 个字母 + 结尾一串数字(>=4)。如 NatalieCom28302 / evelyn_vau7909 / Loralee4839
  const HANDLE_SHAPE = /^[A-Za-z][A-Za-z._]{1,}\d{4,}$/;
  // emoji（Unicode 象形符号）
  const EMOJI_G = /\p{Extended_Pictographic}/gu;
  // 名字装饰 emoji（快速判）
  const NAME_DECOR = /\p{Extended_Pictographic}/u;

  // ============================================================
  // ② 逻辑（普通用户不用动）
  // ============================================================

  // X web app public bearer token, not a user secret. Muting/blocking still requires
  // the current user's browser cookie (`ct0`) and runs only inside x.com/twitter.com.
  const BEARER = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

  // 这是本脚本会发出的**全部**网络请求端点，没有第三方、没有遥测。
  const ENDPOINTS = {
    mute: {
      create: 'https://x.com/i/api/1.1/mutes/users/create.json',
      destroy: 'https://x.com/i/api/1.1/mutes/users/destroy.json',
    },
    block: {
      create: 'https://x.com/i/api/1.1/blocks/create.json',
      destroy: 'https://x.com/i/api/1.1/blocks/destroy.json',
    },
  };
  const ACTION_LABEL = { mute: '静音', block: '屏蔽' };

  const SETTINGS_KEY = 'xspam.settings.v1';
  const LEDGER_KEY = 'xspam.ledger.v1';
  const ATTEMPTS_KEY = 'xspam.attempts.v1';
  const DISPATCH_KEY = 'xspam.dispatch.v1';

  // ---------- 本地存储 ----------
  // 区分两种「不可用」，因为后果不同：
  //   storageAbsent  —— 压根没有 localStorage（罕见/沙箱）：退化成内存计数，仍可动手。
  //   storageFailed  —— 有但访问抛错（隐私模式/配额/被策略禁用）：说明**限速账本写不进去**，
  //                     这时继续发写请求就等于没有上限，所以一律停手（见 pumpQueue）。
  let storageAbsent = false;
  let storageFailed = false;
  function storageUsable() { return !storageAbsent && !storageFailed; }
  function store() {
    try {
      if (typeof localStorage === 'undefined' || !localStorage) { storageAbsent = true; return null; }
      return localStorage;
    } catch (e) { storageFailed = true; return null; }
  }
  function readStore(key) {
    const s = store();
    if (!s) return null;
    try { return s.getItem(key); } catch (e) { storageFailed = true; return null; }
  }
  function writeStore(key, value) {
    const s = store();
    if (!s) return false;
    try { s.setItem(key, value); return true; } catch (e) { storageFailed = true; return false; }
  }
  function parseStore(key, fallback) {
    const raw = readStore(key);
    if (!raw) return fallback;
    try {
      const parsed = JSON.parse(raw);
      return parsed === null || parsed === undefined ? fallback : parsed;
    } catch (e) { return fallback; }
  }

  // ---------- ④ 设置持久化 ----------
  function defaultSettings() {
    return { mode: DEFAULT_MODE, action: DEFAULT_ACTION, threshold: DEFAULT_THRESHOLD };
  }
  function loadSettings() {
    const def = defaultSettings();
    const raw = readStore(SETTINGS_KEY);
    if (!raw) return def;
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { return def; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return def;
    const mode = (parsed.mode === 'mark' || parsed.mode === 'auto') ? parsed.mode : def.mode;
    const action = (parsed.action === 'mute' || parsed.action === 'block') ? parsed.action : def.action;
    const th = parsed.threshold;
    const threshold = (typeof th === 'number' && isFinite(th) && th > 0 && th <= 100) ? th : def.threshold;
    return { mode, action, threshold };
  }
  // 只重读 mode：动作(action)故意**不**重读 —— 条目在入队那一刻绑定了动作，
  // 半路换成另一个动作就是对用户点下去的那一下撒谎。
  function persistedMode() {
    const parsed = parseStore(SETTINGS_KEY, null);
    if (parsed && typeof parsed === 'object' && (parsed.mode === 'mark' || parsed.mode === 'auto')) return parsed.mode;
    return settings.mode;
  }
  function saveSettings() {
    writeStore(SETTINGS_KEY, JSON.stringify(settings));
  }
  const settings = loadSettings();

  // ---------- ⑤ 账本 ----------
  let ledger = [];
  let ledgerEvicted = false;
  let ledgerSeq = 0;
  // 本标签页自上次成功落盘以来改动过的**字段**：id -> Set(字段名)。
  // 🔴 粒度必须到字段，不能只到条目。只改一点元数据（比如取消一条还没发出的撤销，
  //    动的是 undoPending/undoStatus/undoNote）却把整条记录标脏的话，
  //    落盘时会连带把手里那个**过期的 status** 一起写回去 ——
  //    另一个标签页刚推进到 'undone' 的记录会被打回 'ok'，于是它又变得"可撤销"了，
  //    而那层关系其实早就解除了。
  const dirtyLedgerFields = new Map();
  const TERMINAL_STATUSES = ['ok', 'fail', 'unknown', 'undone'];
  function markDirty(id, fields) {
    let set = dirtyLedgerFields.get(id);
    if (!set) { set = new Set(); dirtyLedgerFields.set(id, set); }
    fields.forEach((f) => set.add(f));
  }
  const LEDGER_STATUSES = ['intent', 'ok', 'fail', 'unknown', 'undone'];
  // 账本是从磁盘读回来的外部输入：别人的插件、手改、旧版本都可能留下形状不对的条目。
  // 形状不对的直接丢弃，而不是让它们在撤销路径上炸开。
  function validLedgerEntry(e) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
    if (typeof e.id !== 'string' || !e.id) return false;
    if (typeof e.handle !== 'string' || !e.handle) return false;
    if (e.action !== 'mute' && e.action !== 'block') return false;
    if (LEDGER_STATUSES.indexOf(e.status) < 0) return false;
    return true;
  }
  function loadLedger() {
    const parsed = parseStore(LEDGER_KEY, []);
    if (!Array.isArray(parsed)) return [];
    const clean = parsed.filter(validLedgerEntry);
    // 上限在**载入时**也要压住：上一版可能留下了超额账本，不能等到下一次 append 才收敛。
    if (clean.length > LEDGER_CAP) {
      clean.splice(0, clean.length - LEDGER_CAP);
      ledgerEvicted = true;
    }
    clean.forEach((e) => { e.undoPending = false; });   // 上个 session 飞在半空的撤销不继承
    return clean;
  }
  // 以磁盘上那条为底，只把本标签页真正改过的字段盖上去。
  function applyDirtyFields(onDisk, inMemory, fields) {
    const out = Object.assign({}, onDisk);
    fields.forEach((field) => {
      if (field === 'status'
          && inMemory.status === 'intent'
          && TERMINAL_STATUSES.indexOf(out.status) >= 0) {
        // 已经有结论的记录不许被打回「还没发出」。
        return;
      }
      out[field] = inMemory[field];
    });
    return out;
  }

  // 按时间新旧排：`at` 是 ISO 串，字典序即时间序；同毫秒用 id 兜底（id 里的序号是补零的）。
  function byRecency(a, b) {
    const at = String(a.at || ''), bt = String(b.at || '');
    if (at < bt) return -1;
    if (at > bt) return 1;
    const ai = String(a.id), bi = String(b.id);
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  }

  // 🔴 账本是**跨标签页共享**的一个 key，合并有两个坑，两个都会让真实发生过的动作变得撤不回来：
  //
  //   ① 「同 id 一律内存优先」是错的。本标签页手里那份可能是**过期**的：
  //      A 标签页缓存着 intent，B 标签页把它推成了 ok；A 下次落盘会把 ok 打回 intent。
  //      所以只有**本标签页自己改过**的条目（dirty）才有资格盖过磁盘，其余一律以磁盘为准。
  //
  //   ② 「合并完直接截断」不是 FIFO。Map 是先灌磁盘、再补内存独有的，
  //      一个揣着 2000 条旧缓存的老标签页会把 1999 条旧记录复活、把磁盘上更新的挤掉。
  //      所以截断前必须按时间重排，从**最旧**的那头砍。
  // 合并磁盘 + 本标签页的脏字段，得到「此刻账本真正长什么样」。**不写盘**。
  function mergedLedger() {
    if (storageAbsent || storageFailed) return ledger;
    const stored = parseStore(LEDGER_KEY, []);
    const byId = new Map();
    if (Array.isArray(stored)) stored.forEach((e) => { if (validLedgerEntry(e)) byId.set(e.id, e); });
    // 非 dirty 且磁盘上已经没有的条目 = 别的标签页淘汰掉了，不复活。
    ledger.forEach((e) => {
      const fields = dirtyLedgerFields.get(e.id);
      if (!fields || fields.size === 0) return;
      const onDisk = byId.get(e.id);
      byId.set(e.id, onDisk ? applyDirtyFields(onDisk, e, fields) : e);
    });
    const merged = Array.from(byId.values());
    merged.sort(byRecency);
    if (merged.length > LEDGER_CAP) {
      merged.splice(0, merged.length - LEDGER_CAP);
      ledgerEvicted = true;
    }
    return merged;
  }

  // 🔴 读账本做决定之前必须先合并。缓存里的账本是「上次我看到的样子」，
  //    别的标签页可能已经把某条撤销掉了，也可能又记了更新的一条。
  //    拿旧快照挑「最近一条成功记录」，会去撤一条**已经撤过的**，
  //    同时把真正最新的那条留在原地 —— 两头都错。
  function refreshLedger() { ledger = mergedLedger(); }

  function saveLedger() {
    ledger = mergedLedger();
    const written = writeStore(LEDGER_KEY, JSON.stringify(ledger));
    // 写成功了才算「我这边的改动已经进磁盘」；写失败要留着 dirty 标记等下次再试。
    if (written || storageAbsent) dirtyLedgerFields.clear();
  }
  function ledgerAppend(entry) {
    // 序号补零：id 要能按字典序反映创建顺序（合并排序时拿它当同毫秒的 tie-break）
    entry.id = 'L' + Date.now().toString(36) + '-' + ('000000' + (++ledgerSeq)).slice(-6);
    markDirty(entry.id, Object.keys(entry));   // 全新记录：整条都是我们的
    ledger.push(entry);
    if (ledger.length > LEDGER_CAP) {
      ledger.splice(0, ledger.length - LEDGER_CAP);
      ledgerEvicted = true;
    }
    saveLedger();
    return entry.id;
  }
  function ledgerFind(id) {
    for (let i = ledger.length - 1; i >= 0; i--) if (ledger[i].id === id) return ledger[i];
    return null;
  }
  function ledgerSet(id, patch) {
    const e = ledgerFind(id);
    if (!e) return null;
    Object.keys(patch).forEach((k) => { e[k] = patch[k]; });
    markDirty(id, Object.keys(patch));         // 只有这次真正改到的字段才算脏
    saveLedger();
    return e;
  }
  ledger = loadLedger();

  // ---------- 共享准入控制：尝试次数（计尝试不计成功，持久化） ----------
  const HOUR_MS = 3600 * 1000;
  const DAY_MS = 24 * HOUR_MS;
  let attempts = [];
  function loadAttempts() {
    const parsed = parseStore(ATTEMPTS_KEY, []);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n) => typeof n === 'number' && isFinite(n));
  }
  function pruneAttempts() {
    const cutoff = Date.now() - DAY_MS;
    attempts = attempts.filter((t) => t >= cutoff);
  }
  function attemptsWithin(ms) {
    const cutoff = Date.now() - ms;
    let n = 0;
    for (const t of attempts) if (t >= cutoff) n++;
    return n;
  }
  function attemptCapReason() {
    pruneAttempts();
    if (attemptsWithin(HOUR_MS) >= HOURLY_ATTEMPT_CAP) return '已达每小时尝试上限(' + HOURLY_ATTEMPT_CAP + ')';
    if (attemptsWithin(DAY_MS) >= DAILY_ATTEMPT_CAP) return '已达每日尝试上限(' + DAILY_ATTEMPT_CAP + ')';
    return '';
  }
  // 🔴 名额必须在**每次请求发出之前**当场重读、当场占用，不能只在入队时查一次。
  // 入队和发出之间隔着 6–12 秒 × 队列长度，这中间另一个标签页、另一次批量都可能把名额吃掉；
  // 只在入队口把关，等于批准了一整批，然后闭着眼睛把它们全发出去。
  // 返回 '' = 拿到名额；返回非空字符串 = 拿不到，字符串就是给面板看的原因。
  function reserveAttempt() {
    if (storageFailed) return '本地存储不可用，已停止' + ACTION_LABEL[settings.action];
    if (!storageAbsent) {
      attempts = loadAttempts();                     // 重读：把别的标签页刚记下的也算进来
      if (storageFailed) return '本地存储不可用，已停止' + ACTION_LABEL[settings.action];
    }
    pruneAttempts();
    const capped = attemptCapReason();
    if (capped) return capped;
    attempts.push(Date.now());
    if (!storageAbsent) {
      writeStore(ATTEMPTS_KEY, JSON.stringify(attempts));
      // 记不下来就等于没有上限，那就不许发。
      if (storageFailed) return '本地存储不可用，已停止' + ACTION_LABEL[settings.action];
    }
    return '';
  }
  attempts = loadAttempts();

  // ---------- 多标签页协调：下一次允许发请求的时刻 ----------
  // 两个标签页各有各的内存队列，但共享这一个持久化时刻，所以不会同时开火。
  // ⚠️ 残余限制：两个标签页在同一瞬间读到同一个值，仍可能挤在一起发出两条。
  //    这只是把「同时开火」压成「偶尔撞车」，不是分布式锁。
  function nextAllowedAt() {
    const d = parseStore(DISPATCH_KEY, null);
    if (!d || typeof d !== 'object' || typeof d.nextAllowedAt !== 'number' || !isFinite(d.nextAllowedAt)) return 0;
    return d.nextAllowedAt;
  }
  // 返回 gap；写不进去返回 -1（调用方必须当成「不能发」）
  function reserveDispatchSlot() {
    const gap = ACTION_MIN_GAP + Math.floor((ACTION_MAX_GAP - ACTION_MIN_GAP) * Math.random());
    writeStore(DISPATCH_KEY, JSON.stringify({ nextAllowedAt: Date.now() + gap }));
    return storageFailed ? -1 : gap;
  }
  function dispatchWaitMs() {
    const at = nextAllowedAt();
    if (!at) return 0;
    const wait = at - Date.now();
    if (wait <= 0) return 0;
    // 任何合法预留都不会超过一个最大间隔。超了只可能是时钟漂移或脏数据，
    // 那就不理会 —— 否则一个坏值能把队列永远锁死。
    if (wait > ACTION_MAX_GAP) return 0;
    return wait;
  }

  // ---------- 运行态 ----------
  const queuedHandles = new Set();
  const actionedHandles = new Set();
  const flaggedOriginalHandleByKey = new Map();
  const flaggedCellsByHandle = new Map();
  const seenCellsByHandle = new Map();   // 所有见过的卡片（簇形成后要回扫），按 handle 有界
  let actionedCount = 0, actionedThisSession = 0;
  const queue = []; let queueBusy = false;
  let queuePaused = false, pauseReason = '';
  let notice = '';
  let evidenceRevision = 0;

  function getCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }

  // 把元素里的文字 + emoji(从 <img alt> 抠出) + 换行 还原成纯文本。
  // 关键：X 把 emoji 渲染成 <img alt="🌸">，普通 innerText 读不到 emoji，必须走这里。
  function richText(el) {
    if (!el) return '';
    let out = '';
    el.childNodes.forEach((n) => {
      if (n.nodeType === 3) out += n.textContent;
      else if (n.nodeType === 1) {
        const tag = n.tagName;
        if (tag === 'IMG') out += (n.getAttribute('alt') || '');
        else if (tag === 'BR') out += '\n';
        else {
          const disp = (n.ownerDocument.defaultView.getComputedStyle(n).display || '');
          out += richText(n);
          if (disp === 'block' || disp === 'flex') out += '\n';
        }
      }
    });
    return out;
  }

  function emojiStats(text) {
    const emojiCount = (text.match(EMOJI_G) || []).length;
    const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
    let emojiOnlyLines = 0;
    for (const l of lines) {
      if (!EMOJI_G.test(l)) { EMOJI_G.lastIndex = 0; continue; }
      EMOJI_G.lastIndex = 0;
      const stripped = l.replace(EMOJI_G, '').replace(/[️‍\s]/g, '');
      if (stripped === '') emojiOnlyLines++;
    }
    return { emojiCount, emojiOnlyLines };
  }

  function hashText(text) {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = ((h * 31) + text.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function countTermHits(text, terms) {
    let n = 0;
    for (const term of terms) if (text.includes(term)) n++;
    return n;
  }

  function isMentionReferral(text) {
    const compact = text.replace(/\s+/g, '').toLowerCase();
    if (!/@\w+/.test(text)) return false;
    const cueHits = countTermHits(compact, REFERRAL_CUES);
    if (cueHits >= 2) return true;
    if (cueHits >= 1 && MENTION_CODE.test(text)) return true;
    return false;
  }

  // ============================================================
  // ① 归一化 normalize —— 只服务模板指纹，不影响 score() 的关键词匹配
  // ============================================================
  // 目的：让「同一句话换 emoji / 换尾码 / 换全角标点 / 换同形字」被认成同一条模板。
  const HOMOGLYPHS = [['貨', '货'], ['沒', '没'], ['sao', '骚']];
  const URL_PATH_RE = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\/[^\s　]*/gi;
  const URL_BARE_RE = /\b[a-z0-9-]+\.(?:com|net|org|top|xyz|vip|cyou|icu|club|live|cc|shop|fun|link|life|me|io|app)\b/gi;
  const MENTION_RE = /@\w+/g;
  // 零宽空格/连接符 + BOM + 变体选择符（emoji 后面那个看不见的 U+FE0F 就是它）
  const INVISIBLE_RE = /[\u200B-\u200D\uFEFF\uFE00-\uFE0F]/g;
  // 全角标点与全角空格（NFKC 之后一般已经没了，这里兜住环境不支持 normalize 的情况）
  const FULLWIDTH_PUNCT_RE = /[\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65\u3000-\u303F]/g;
  const PUNCT_SPACE_RE = /[\p{P}\p{S}\p{Z}\s]/gu;
  const ISOLATED_CODE_RE = /(^|[^a-z0-9])([a-z0-9]{1,3})(?=[^a-z0-9]|$)/g;

  function normalize(text) {
    let t = String(text == null ? '' : text);
    // 1) 先摘出 @提及 与 URL —— 必须最先做：后面去标点会把 `@` 和 `/` 删掉，
    //    到那时 `@handle` 就和正文粘成一团，再也摘不干净。
    t = t.replace(/https?:\/\/\S+/gi, ' ');
    t = t.replace(URL_PATH_RE, ' ');
    t = t.replace(URL_BARE_RE, ' ');
    t = t.replace(MENTION_RE, ' ');
    // 2) NFKC：全角 → 半角、兼容字形归一
    if (typeof t.normalize === 'function') { try { t = t.normalize('NFKC'); } catch (e) { /* 环境不支持就跳过 */ } }
    // 3) 去 emoji / 零宽连接符 / 变体选择符
    t = t.replace(/\p{Extended_Pictographic}/gu, '');
    t = t.replace(INVISIBLE_RE, '');
    // 4) 小写 + 极小同形表。
    //    ⚠️ 顺序说明：同形表提前到「去尾码」之前，否则 `sao` 这种 3 位拉丁词会先被当成批次码删掉，
    //    `sao货` 与 `骚货` 就再也归不到同一条模板上。
    t = t.toLowerCase();
    for (const [from, to] of HOMOGLYPHS) t = t.split(from).join(to);
    // 5) 去标点与空白（Unicode P/S/Z 三类 + 全角形）
    t = t.replace(FULLWIDTH_PUNCT_RE, '');
    t = t.replace(PUNCT_SPACE_RE, '');
    // 6) 去孤立的 1–3 位字母/数字尾码（`1e`、`5d`、`2j` 这类每号一变的批次码）
    t = t.replace(ISOLATED_CODE_RE, '$1');
    t = t.replace(ISOLATED_CODE_RE, '$1');   // 跑两遍：相邻尾码会因为正则不重叠而漏掉一个
    return t;
  }

  // ============================================================
  // ② 模板指纹簿 TemplateBook —— 认「多个号说同一句话」，不认字
  // ============================================================
  function pageKey() {
    const path = (location && location.pathname) || '';
    const m = path.match(/\/status\/(\d+)/);
    return m ? m[1] : 'home';
  }
  const templateBook = new Map();   // bucketKey -> Map(norm -> {authors:Set, clustered:boolean})
  let templateTotal = 0;
  let currentBucket = pageKey();
  let currentPath = (location && location.pathname) || '';

  function bucketFor(key) {
    let b = templateBook.get(key);
    if (!b) { b = new Map(); templateBook.set(key, b); }
    return b;
  }
  function dropBucket(key) {
    const b = templateBook.get(key);
    if (!b) return;
    templateTotal -= b.size;
    if (templateTotal < 0) templateTotal = 0;
    templateBook.delete(key);
  }
  function trimTemplates(bucket) {
    while (bucket.size > TEMPLATE_BUCKET_CAP) {
      const oldest = bucket.keys().next().value;
      bucket.delete(oldest); templateTotal--;
    }
    while (templateTotal > TEMPLATE_GLOBAL_CAP) {
      const oldestBucketKey = templateBook.keys().next().value;
      const ob = templateBook.get(oldestBucketKey);
      if (!ob || ob.size === 0) { templateBook.delete(oldestBucketKey); continue; }
      const oldest = ob.keys().next().value;
      ob.delete(oldest); templateTotal--;
      if (ob.size === 0) templateBook.delete(oldestBucketKey);
    }
  }

  let rescanning = false;
  // 返回：该模板当前的不同作者数（未成簇返回 0）
  function noteTemplate(bucketKey, handle, norm) {
    if (!norm || norm.length < 8) return 0;
    if (new Set(Array.from(norm)).size < 4) return 0;
    const bucket = bucketFor(bucketKey);
    let entry = bucket.get(norm);
    if (entry) bucket.delete(norm);       // LRU：碰过就挪到队尾
    else { entry = { authors: new Set(), clustered: false }; templateTotal++; }
    bucket.set(norm, entry);
    const key = handle.toLowerCase();
    if (!entry.authors.has(key) && entry.authors.size < TEMPLATE_AUTHOR_CAP) entry.authors.add(key);
    trimTemplates(bucket);
    const n = entry.authors.size;
    if (n >= CLUSTER_MIN && !entry.clustered) {
      entry.clustered = true;
      // 簇一旦形成，先前已判定过的同伙卡片必须回扫：证据版本号 +1 让旧签名失效。
      evidenceRevision++;
      rescanMembers(entry.authors, key);
    }
    return n >= CLUSTER_MIN ? n : 0;
  }

  function rescanMembers(authorKeys, skipKey) {
    if (rescanning) return;
    rescanning = true;
    try {
      authorKeys.forEach((k) => {
        if (k === skipKey) return;
        const cells = seenCellsByHandle.get(k);
        if (!cells) return;
        Array.from(cells).forEach((cell) => {
          if (!cell || cell.isConnected === false) { cells.delete(cell); return; }
          processCell(cell);
        });
      });
    } finally { rescanning = false; }
  }

  function rememberSeenCell(handle, cell) {
    const key = handle.toLowerCase();
    if (!seenCellsByHandle.has(key) && seenCellsByHandle.size >= MAX_TRACKED_HANDLES) {
      const oldest = seenCellsByHandle.keys().next().value;
      seenCellsByHandle.delete(oldest);
    }
    if (!seenCellsByHandle.has(key)) seenCellsByHandle.set(key, new Set());
    const cells = seenCellsByHandle.get(key);
    cells.forEach((tracked) => { if (tracked !== cell && tracked.isConnected === false) cells.delete(tracked); });
    cells.add(cell);
  }

  function cellSignature(name, handle, text, revision) {
    return handle.toLowerCase() + ':' + revision + ':' + hashText(name + '\n' + text);
  }

  // 综合评分：形态 + 行为(emoji沙拉) + 语义(软token/bait) + 露骨词 + 链接
  // ⚠️ 这里**不含**簇分。簇分在 processCell 里单独加，且只加进「标记分」，不进「自动出手分」。
  function score(name, handle, text) {
    let s = 0; const r = [];
    const hay = name + ' ' + text;

    if (HANDLE_SHAPE.test(handle)) { s += W.handleShape; r.push('handle形态'); }

    const es = emojiStats(text);
    if (es.emojiOnlyLines >= 2 || es.emojiCount >= 5) { s += W.emojiSalad; r.push('emoji沙拉(' + es.emojiCount + ')'); }
    else if (es.emojiCount >= 3) { s += W.emojiFew; r.push('emoji×' + es.emojiCount); }

    for (const k of EXPLICIT) if (hay.includes(k)) { s += W.explicit; r.push('露骨:' + k); break; }
    for (const k of NAME_SOFT) if (name.includes(k)) { s += W.nameSoft; r.push('软名:' + k); break; }
    let baitN = 0; for (const k of BAIT) if (hay.includes(k)) { baitN++; if (baitN <= 2) { s += W.bait; r.push('搭讪:' + k); } }
    for (const re of LINK_PATTERNS) if (re.test(hay)) { s += W.link; r.push('链接'); break; }
    const cityHits = countTermHits(hay, CITY_TERMS);
    if (cityHits >= 8) { s += W.cityBurst; r.push('城市串(' + cityHits + ')'); }
    for (const k of CONTACT_CUES) if (hay.includes(k)) { s += W.contactCue; r.push('联系:' + k); break; }
    if (isMentionReferral(text)) { s += W.mentionReferral; r.push('短评@引流'); }
    if (NAME_DECOR.test(name)) { s += W.nameEmoji; r.push('名emoji'); }

    return { s, reasons: r };
  }

  // ============================================================
  // 抽取层：只取**作者本人**的正文；引用推文里的文字不算在作者头上
  // ============================================================
  // X 把「被引用的那条推」渲染成卡片内部的一个可点区域（多为 div[role="link"][tabindex="0"]，
  // 有时直接嵌一个 <article>）。真人引用了一条垃圾回复，不该因此被判成垃圾号。
  //
  // 🔴 这里有个必须先解决的坑：**嵌套方向有两个**。
  //    真实 x.com 上外层通常是 div[data-testid="cellInnerDiv"]，作者本人那条推的
  //    <article data-testid="tweet"> 在它**里面**；而我们的扫描器取的是最外层卡片。
  //    如果直接从最外层往下找 tweetText、再把「路径上出现过 article」当成引用块，
  //    那作者自己的正文会被自己那层 article 挡掉 —— 结果是整站一条都识别不出来，而且悄无声息。
  //    所以：先定位「这张卡片属于哪条推」（owner），再只在 owner 内部排除引用块。
  const QUOTE_ANCESTOR_SEL = 'article, [data-testid="tweet"], div[role="link"][tabindex="0"], [data-testid="quoteTweet"]';
  const TWEET_SEL = 'article[data-testid="tweet"]';

  // owner = 本卡片所代表的那条推的根节点
  function owningTweetNode(cell) {
    if (cell.matches && cell.matches(TWEET_SEL)) return cell;
    const inner = cell.querySelector ? cell.querySelector(TWEET_SEL) : null;
    return inner || cell;
  }
  // 从 textEl 往上走到 owner 为止：中途撞见引用容器（含**嵌套的** article）才算引用内容。
  // owner 自身不参与判定，所以作者本人那层 article 不会误伤。
  function isAuthorOwnText(owner, textEl) {
    for (let p = textEl.parentElement; p && p !== owner; p = p.parentElement) {
      if (p.matches && p.matches(QUOTE_ANCESTOR_SEL)) return false;
    }
    return true;
  }
  function pickAuthorTextEl(owner) {
    const list = owner.querySelectorAll('[data-testid="tweetText"]');
    for (let i = 0; i < list.length; i++) {
      if (isAuthorOwnText(owner, list[i])) return list[i];
    }
    return null;
  }

  function extract(cell) {
    const owner = owningTweetNode(cell);
    const nameBlock = owner.querySelector('[data-testid="User-Name"]');
    let name = '', handle = '';
    if (nameBlock) {
      const txt = richText(nameBlock);
      const at = txt.match(/@(\w+)/);
      if (at) handle = at[1];
      name = txt.split('@')[0].replace(/\s+/g, ' ').trim();
    }
    if (!handle) {
      const a = cell.querySelector('a[role="link"][href^="/"]');
      if (a) { const m = a.getAttribute('href').match(/^\/(\w+)$/); if (m) handle = m[1]; }
    }
    const textEl = pickAuthorTextEl(owner);
    const text = textEl ? richText(textEl) : '';
    return { name, handle, text };
  }

  // ============================================================
  // 共享准入控制 Admission —— 单击 / 批量 / 撤销 全部走这一条队列
  // ============================================================
  // 取消一个**还没发出去**的条目。
  // 🔴 撤销条目和动作条目的取消后果不一样：动作条目从没发生过 ⇒ intent 记 fail；
  //    撤销条目取消掉，原来那条动作**仍然是成功的** ⇒ 绝不能把它的 status 改成 fail，
  //    否则「已经静音了但账本说失败」，这条记录就再也撤销不了了。
  function cancelEntry(entry, note) {
    queuedHandles.delete(entry.handle.toLowerCase());
    if (!entry.ledgerId) return;
    if (entry.kind === 'undo') ledgerSet(entry.ledgerId, { undoPending: false, undoStatus: 'cancelled', undoNote: note });
    else ledgerSet(entry.ledgerId, { status: 'fail', note });
  }

  function drainQueue(note, filter) {
    const kept = [];
    queue.splice(0, queue.length).forEach((e) => {
      if (filter && !filter(e)) { kept.push(e); return; }
      cancelEntry(e, note);
    });
    kept.forEach((e) => queue.push(e));
  }

  function pauseQueue(reason) {
    queuePaused = true;
    pauseReason = reason;
    drainQueue('队列已暂停，未发出');   // 出错即停，不重试、不自动恢复
    updatePanel();
  }

  function enqueue(entry) {
    if (queuePaused) { notice = '队列已暂停：' + pauseReason; return false; }
    // 入队口只做一次粗筛（省得白排一长串）；真正的名额是在发出前当场占的，见 pumpQueue。
    const capped = attemptCapReason();
    if (capped) { notice = capped + '，本次不再入队'; updatePanel(); return false; }
    entry.path = location.pathname;
    queue.push(entry);
    return true;
  }

  // origin: 'auto' = 自动模式自己排的（模式切回手动要作废）
  //         'manual' = 用户点了按钮（模式切换不影响）
  function enqueueAction(handle, evidence, action, origin) {
    const key = handle.toLowerCase();
    if (actionedHandles.has(key) || queuedHandles.has(key)) return false;
    const act = (action === 'mute' || action === 'block') ? action : settings.action;
    const ledgerId = ledgerAppend({
      handle, userId: null, action: act,
      score: evidence.score, reasons: evidence.reasons,
      page: pageKey(), at: new Date().toISOString(), status: 'intent',
    });
    const ok = enqueue({ kind: 'do', origin: origin || 'manual', handle, action: act, ledgerId });
    if (!ok) { ledgerSet(ledgerId, { status: 'fail', note: '未入队' }); return false; }
    queuedHandles.add(key);
    return true;
  }

  function enqueueUndo() {
    refreshLedger();       // 先看清楚现在账本到底是什么样，再挑要撤哪一条
    for (let i = ledger.length - 1; i >= 0; i--) {
      const e = ledger[i];
      if (e.status !== 'ok' || e.undoPending) continue;
      const id = e.id, handle = e.handle, action = e.action;
      ledgerSet(id, { undoPending: true });    // 走 ledgerSet 才会被标脏并落盘
      const ok = enqueue({ kind: 'undo', origin: 'undo', handle, action, ledgerId: id });
      if (!ok) { ledgerSet(id, { undoPending: false }); return false; }
      updatePanel();
      pumpQueue();
      return true;
    }
    notice = '账本里没有可撤销的成功记录';
    updatePanel();
    return false;
  }

  async function performEntry(entry) {
    const isUndo = entry.kind === 'undo';
    const ct0 = getCookie('ct0');
    if (!ct0) {
      console.warn('[x-spam] 未登录(无 ct0)');
      // 这一条根本没发出去。对撤销来说，原来那次动作**仍然是成功的**，
      // 把它标成 fail 会让这条记录从此撤不掉。
      if (isUndo) ledgerSet(entry.ledgerId, { undoPending: false, undoStatus: 'fail', undoNote: '未登录' });
      else ledgerSet(entry.ledgerId, { status: 'fail', note: '未登录' });
      pauseQueue('未登录(无 ct0)');
      return;
    }
    const url = ENDPOINTS[entry.action][isUndo ? 'destroy' : 'create'];
    // 撤销时优先用 user_id：handle 可能已经改名，改了名 screen_name 就指不回同一个人。
    // 两个 destroy 端点都收 user_id。
    const led = ledgerFind(entry.ledgerId);
    const userId = led && typeof led.userId === 'string' && led.userId ? led.userId : '';
    const idField = (isUndo && userId)
      ? 'user_id=' + encodeURIComponent(userId)
      : 'screen_name=' + encodeURIComponent(entry.handle);
    // 🔴 一条永远不返回的请求会把整条共享队列钉死在 busy 上：不再发、不再停、面板也不说话。
    //    所以每条请求都挂一个中止闸，超时就当结果不明处理并停队（超时不代表没生效）。
    let controller = null, timeoutId = null, timedOut = false;
    if (typeof AbortController === 'function') {
      controller = new AbortController();
      timeoutId = setTimeout(() => {
        timedOut = true;
        try { controller.abort(); } catch (e) { /* 已经结束了就无所谓 */ }
      }, REQUEST_TIMEOUT_MS);
    }
    const clearRequestTimeout = () => {
      if (timeoutId !== null) { clearTimeout(timeoutId); timeoutId = null; }
    };
    const failOpen = (label) => {
      // 请求已经发出去了，只是我们没等到答复 —— 服务端可能已经执行了。
      if (isUndo) ledgerSet(entry.ledgerId, { undoPending: false, undoStatus: 'unknown', undoNote: label });
      else ledgerSet(entry.ledgerId, { status: 'unknown', note: label });
      queuedHandles.delete(entry.handle.toLowerCase());
      pauseQueue(label + '，已停止');
    };

    let res;
    try {
      const init = {
        method: 'POST',
        headers: {
          'authorization': BEARER, 'x-csrf-token': ct0,
          'x-twitter-active-user': 'yes', 'x-twitter-auth-type': 'OAuth2Session',
          'content-type': 'application/x-www-form-urlencoded',
        },
        credentials: 'include',
        body: idField + '&skip_status=1',
      };
      if (controller) init.signal = controller.signal;
      res = await fetch(url, init);
    } catch (e) {
      clearRequestTimeout();
      console.warn('[x-spam] 请求异常', entry.handle, e);
      failOpen(timedOut ? '请求超时' : '网络异常');
      return;
    }
    if (res && res.ok) {
      if (isUndo) {
        ledgerSet(entry.ledgerId, { status: 'undone', undoPending: false, undoStatus: 'ok' });
        actionedHandles.delete(entry.handle.toLowerCase());
        if (actionedCount > 0) actionedCount--;
        notice = '已撤销 @' + entry.handle;
      } else {
        ledgerSet(entry.ledgerId, { status: 'ok' });
        actionedCount++; actionedThisSession++;
        markHandleActioned(entry.handle, entry.action);
      }
      queuedHandles.delete(entry.handle.toLowerCase());
      // ⚠️ 走到这里说明请求**已经拿到响应**了 —— 所以不看 timedOut：
      //    真超时的话上面那个 await 会抛，根本到不了这一行。
      let bodyAborted = false;
      if (typeof res.json === 'function') {
        // 读 body 也可能挂住（响应头到了、body 不来），所以中止闸留到这之后才撤。
        try {
          const body = await res.json();
          if (body && typeof body.id_str === 'string') ledgerSet(entry.ledgerId, { userId: body.id_str });
        } catch (e) { bodyAborted = timedOut; }
      }
      clearRequestTimeout();
      updatePanel();
      // body 读一半被掐断：动作本身已经成功（res.ok 已经拿到了），状态不动，
      // 但连接明显不正常，队列停下来等人看一眼。
      if (bodyAborted) pauseQueue('请求超时，已停止');
      return;
    }
    clearRequestTimeout();
    const status = res ? res.status : 0;
    console.warn('[x-spam] ' + ACTION_LABEL[entry.action] + '失败', entry.handle, status);
    queuedHandles.delete(entry.handle.toLowerCase());
    const hardStop = (status === 429 || status === 401 || status === 403);
    if (isUndo) {
      // 撤销失败不改动原动作的 status：那条动作确实成功过，将来还能再撤一次。
      ledgerSet(entry.ledgerId, { undoPending: false, undoStatus: hardStop ? 'unknown' : 'fail', undoNote: 'HTTP ' + status });
    } else if (hardStop) {
      // 结果不明 + 明确的风控信号：标 unknown
      ledgerSet(entry.ledgerId, { status: 'unknown', note: 'HTTP ' + status });
    } else {
      ledgerSet(entry.ledgerId, { status: 'fail', note: 'HTTP ' + status });
    }
    if (hardStop) pauseQueue('HTTP ' + status + '（已停止，不自动恢复）');
    else updatePanel();
  }

  // 发出前的最后一道闸：这里是**唯一**真正决定「这一条能不能发」的地方。
  // 入队时的检查只是省事，条目在队列里可能躺了好几分钟，期间什么都可能变。
  // 返回 '' = 放行；'skip:<note>' = 这条作废但队列继续；其它字符串 = 整队暂停的原因。
  function admitBeforeSend(entry) {
    if (entry.path !== location.pathname) return 'skip:路由已切换，未发出';
    if (entry.kind === 'undo') {
      // 排队到发出之间可能隔着几分钟，另一个标签页完全可能已经把它撤掉了。
      // 对一条已经不是「成功」的记录再发一次 destroy，解除的就是别的东西了。
      refreshLedger();
      const rec = ledgerFind(entry.ledgerId);
      if (!rec) return 'undostale:账本里已经没有这条记录';
      if (rec.status !== 'ok') return 'undostale:这条已经不是「成功」状态了';
      if (rec.undoPending === false) return 'undostale:这条撤销已被别处处理';
    }
    // 模式在这里**重读磁盘**：另一个标签页把模式切回手动，意思就是「别再自己动手了」，
    // 这个意图必须能穿过标签页边界，而不是只对点了按钮的那一个窗口生效。
    if (entry.kind === 'do' && entry.origin === 'auto'
        && (settings.mode !== 'auto' || persistedMode() !== 'auto')) {
      return 'skip:模式切回手动，未发出';
    }
    if (actionedThisSession >= AUTO_BLOCK_SESSION_CAP) return '本次会话已达上限，刷新页面后继续';
    return reserveAttempt();          // 名额在这里当场重读、当场占用
  }

  function pumpQueue() {
    if (queueBusy || queuePaused || !queue.length) return;

    // 多标签页节流：别的标签页刚发过，就等到它约定的时刻再说。
    // 🔴 这里**没有**「等够几次就放行」的旁路 —— 那种旁路等于宣布限速可以被耐心绕过。
    //    每次醒来都重新读一遍共享时刻，没到点就接着等。
    const wait = dispatchWaitMs();
    if (wait > 0) {
      queueBusy = true;
      setTimeout(() => { queueBusy = false; pumpQueue(); }, wait);
      return;
    }

    const entry = queue.shift();
    const verdict = admitBeforeSend(entry);
    if (verdict) {
      if (verdict.indexOf('undostale:') === 0) {
        // 不是失败，是「已经不需要做了」——原记录的 status 一个字都不动。
        ledgerSet(entry.ledgerId, { undoPending: false, undoStatus: 'skipped', undoNote: verdict.slice(10) });
        queuedHandles.delete(entry.handle.toLowerCase());
        notice = '撤销已跳过：' + verdict.slice(10);
        updatePanel();
        pumpQueue();
        return;
      }
      if (verdict.indexOf('skip:') === 0) {
        cancelEntry(entry, verdict.slice(5));   // 这一条作废，不占名额，队列继续往下走
        updatePanel();
        pumpQueue();
        return;
      }
      // 拿不到名额 / 存储写不进去 ⇒ 这条也退回，整队停下
      cancelEntry(entry, verdict);
      pauseQueue(verdict);
      return;
    }

    queueBusy = true;
    const gap = reserveDispatchSlot();   // 名额已占，先把下一次允许发送的时刻钉出去
    if (gap < 0) {
      // 时刻戳都写不进去 ⇒ 下一条无从知道该等多久 ⇒ 限速已经失效，停手。
      queueBusy = false;
      const why = '本地存储不可用，已停止' + ACTION_LABEL[entry.action];
      cancelEntry(entry, why);
      pauseQueue(why);
      return;
    }
    let settled = false;
    const release = () => {
      if (settled) return;
      settled = true;
      setTimeout(() => { queueBusy = false; pumpQueue(); }, gap);
    };
    performEntry(entry).then(release, (err) => {
      // performEntry 内部不该抛，但真抛了也不能留下一条永远 intent 的账、
      // 一个永远排着的 handle、和一个卡死的队列。
      console.warn('[x-spam] 队列条目异常', err);
      queuedHandles.delete(entry.handle.toLowerCase());
      if (entry.kind === 'undo') ledgerSet(entry.ledgerId, { undoPending: false, undoStatus: 'unknown', undoNote: '请求异常' });
      else ledgerSet(entry.ledgerId, { status: 'unknown', note: '请求异常' });
      pauseQueue('请求异常，已停止');
      release();
    });
  }

  function rememberFlaggedCell(handle, cell) {
    const key = handle.toLowerCase();
    flaggedOriginalHandleByKey.set(key, handle);
    if (!flaggedCellsByHandle.has(key) && flaggedCellsByHandle.size >= MAX_TRACKED_HANDLES) {
      const oldest = flaggedCellsByHandle.keys().next().value;
      flaggedCellsByHandle.delete(oldest);
      flaggedOriginalHandleByKey.delete(oldest);
    }
    if (!flaggedCellsByHandle.has(key)) flaggedCellsByHandle.set(key, new Set());
    const cells = flaggedCellsByHandle.get(key);
    cells.forEach((tracked) => { if (tracked !== cell && tracked.isConnected === false) cells.delete(tracked); });
    cells.add(cell);
  }

  // 队列条目只带 handle + 证据，不持有 DOM 引用；要打勾时按 handle 现查卡片。
  // action 来自**真正执行掉的那个条目**，不是面板此刻的设置 —— 面板可能在排队期间被切过。
  function markHandleActioned(handle, action) {
    const key = handle.toLowerCase();
    actionedHandles.add(key);
    const cells = flaggedCellsByHandle.get(key) || seenCellsByHandle.get(key) || new Set();
    cells.forEach((cell) => { if (cell && cell.isConnected !== false) markCellActioned(cell, handle, action); });
    updatePanel();
  }

  // 卡片降到阈值以下、或者这张 DOM 被 X 复用给了另一个人时，必须把红框/角标/按钮撤干净，
  // 否则会留下一个「按了就动手」的按钮挂在一个已经不该被处理的人身上。
  function unmarkCell(cell) {
    if (!cell.dataset) return;
    const badge = cell.querySelector('.xspam-badge');
    const btn = cell.querySelector('.xspam-action-btn');
    // 「✓ 已静音 @某人」这个角标最要命：DOM 一被 X 回收给另一个人，
    // 上面就会挂着别人的处理结果。所以它和置灰必须一起撤。
    const doneTag = cell.querySelector('.xspam-blocked-tag');
    if (cell.dataset.xspam !== '1' && !badge && !btn && !doneTag) return;
    const prevKey = cell.dataset.xspamHandle || '';
    delete cell.dataset.xspam;
    delete cell.dataset.xspamHandle;
    cell.style.outline = '';
    cell.style.outlineOffset = '';
    cell.style.opacity = '';
    if (badge) badge.remove();
    if (btn) btn.remove();
    if (doneTag) doneTag.remove();
    if (prevKey) {
      const cells = flaggedCellsByHandle.get(prevKey);
      if (cells) {
        cells.delete(cell);
        if (cells.size === 0) { flaggedCellsByHandle.delete(prevKey); flaggedOriginalHandleByKey.delete(prevKey); }
      }
    }
    updatePanel();   // 「本页疑似(n)」要跟着掉下来，否则面板还在替一张已经撤销的卡片计数
  }

  function renderActionButton(btn, action) {
    btn.dataset.xspamAction = action;
    btn.textContent = ACTION_LABEL[action];
  }

  // 面板切换动作时，把所有**还没点过**的卡片按钮重新渲染成新动作。
  // 已经排队/已处理的按钮不动：它们绑定的动作已经写进队列条目了，改标签只会骗人。
  function rerenderActionButtons() {
    flaggedCellsByHandle.forEach((cells) => {
      cells.forEach((cell) => {
        if (!cell || cell.isConnected === false) return;
        const btn = cell.querySelector('.xspam-action-btn');
        if (btn && !btn.disabled) renderActionButton(btn, settings.action);
      });
    });
  }

  function markCellSpam(cell, handle, reasons) {
    if (cell.dataset.xspam) return;
    cell.dataset.xspam = '1';
    cell.dataset.xspamHandle = handle.toLowerCase();
    cell.style.outline = '2px solid #e0245e';
    cell.style.outlineOffset = '-2px';
    if (getComputedStyle(cell).position === 'static') cell.style.position = 'relative';

    const badge = document.createElement('div');
    badge.className = 'xspam-badge';
    badge.textContent = '⚠ 疑似垃圾号';
    badge.style.cssText = 'position:absolute;top:6px;right:8px;z-index:9;background:#e0245e;color:#fff;font-size:11px;padding:2px 6px;border-radius:6px;font-weight:700;';
    const btn = document.createElement('button');
    btn.className = 'xspam-action-btn';
    // 🔴 按钮把动作**绑在自己身上**。否则会出现：卡片在「静音」模式下标出来、显示「静音」按钮，
    //    用户去面板切成「屏蔽」，回头点这个还写着「静音」的按钮 —— 结果把人屏蔽了。
    renderActionButton(btn, settings.action);
    btn.title = '命中: ' + reasons.join(', ');
    btn.style.cssText = 'position:absolute;top:30px;right:8px;z-index:9;background:#e0245e;color:#fff;border:none;font-size:12px;padding:4px 10px;border-radius:14px;cursor:pointer;font-weight:700;';
    btn.addEventListener('click', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      const bound = btn.dataset.xspamAction === 'block' ? 'block' : 'mute';
      const queued = enqueueAction(handle, { score: null, reasons }, bound, 'manual');
      if (queued) { btn.textContent = '已排队…'; btn.disabled = true; pumpQueue(); }
      else { btn.textContent = '未入队'; }
      updatePanel();
    });
    cell.appendChild(badge); cell.appendChild(btn);
    updatePanel();
  }

  function markCellActioned(cell, handle, action) {
    // 只走「已处理」这条路的卡片不会经过 markCellSpam，但它同样挂着一个写了名字的角标，
    // 所以身份也必须记在节点上 —— 否则这张 DOM 被回收给别人时没人认得出该清理。
    if (cell.dataset) cell.dataset.xspamHandle = handle.toLowerCase();
    cell.style.opacity = '0.35';
    let tag = cell.querySelector('.xspam-blocked-tag');
    if (!tag) {
      tag = document.createElement('div');
      tag.className = 'xspam-blocked-tag';
      tag.textContent = '✓ 已' + ACTION_LABEL[action] + ' @' + handle;
      tag.style.cssText = 'position:absolute;top:6px;right:8px;z-index:9;background:#536471;color:#fff;font-size:11px;padding:2px 6px;border-radius:6px;font-weight:700;';
      if (getComputedStyle(cell).position === 'static') cell.style.position = 'relative';
      cell.appendChild(tag);
    }
  }

  function actionOfHandle(key) {
    for (let i = ledger.length - 1; i >= 0; i--) {
      if (ledger[i].handle.toLowerCase() === key && ledger[i].status === 'ok') return ledger[i].action;
    }
    return settings.action;
  }

  function processCell(cell) {
    const { name, handle, text } = extract(cell);
    if (!handle) return;                       // 内容还没渲染完，下次扫描再重试
    const key = handle.toLowerCase();
    // X 会复用 DOM 节点：同一张卡片下一秒可能已经是另一个人了。旧标记必须先撤。
    if (cell.dataset && cell.dataset.xspamHandle && cell.dataset.xspamHandle !== key) unmarkCell(cell);
    const signature = cellSignature(name, handle, text, evidenceRevision);
    if (cell.dataset && cell.dataset.xspamSignature === signature) return;
    if (cell.dataset) cell.dataset.xspamSignature = signature;

    rememberSeenCell(handle, cell);
    const base = score(name, handle, text);
    const clusterN = noteTemplate(currentBucket, handle, normalize(text));

    let total = base.s;
    const reasons = base.reasons.slice();
    if (clusterN >= CLUSTER_MIN) { total += W.cluster; reasons.push('簇×' + clusterN); }

    if (total < settings.threshold) { unmarkCell(cell); return; }

    rememberFlaggedCell(handle, cell);
    if (actionedHandles.has(key)) { markCellActioned(cell, handle, actionOfHandle(key)); return; }
    markCellSpam(cell, handle, reasons);
    // 🔴 自动出手只认**不含簇分**的独立信号：真人粉丝团复读同一句口号最多被标红供复核。
    if (settings.mode === 'auto' && base.s >= settings.threshold && !queuedHandles.has(key)) {
      enqueueAction(handle, { score: base.s, reasons: base.reasons }, settings.action, 'auto');
      pumpQueue();
    }
  }

  function visibleFlaggedHandles() {
    const handles = [];
    flaggedCellsByHandle.forEach((cells, key) => {
      if (actionedHandles.has(key) || queuedHandles.has(key)) return;
      let visible = false;
      cells.forEach((cell) => {
        if (!cell || cell.isConnected === false) cells.delete(cell);
        else if (cell.dataset && cell.dataset.xspam === '1') visible = true;
      });
      if (visible) handles.push({ key, handle: flaggedOriginalHandleByKey.get(key) || key });
    });
    return handles;
  }

  function actMarkedVisible(btn) {
    const handles = visibleFlaggedHandles();
    if (!handles.length) { updatePanel(); return; }
    const selected = handles.slice(0, BATCH_BLOCK_CLICK_CAP);
    const label = ACTION_LABEL[settings.action];
    const suffix = handles.length > selected.length ? '（本次最多先处理 ' + selected.length + ' 个，剩余可稍后再点）' : '';
    const ok = typeof window.confirm !== 'function' || window.confirm('将慢速' + label + '当前页已标记的 ' + selected.length + ' 个疑似垃圾账号' + suffix + '。继续吗？');
    if (!ok) return;
    let queued = 0;
    selected.forEach(({ handle }) => { if (enqueueAction(handle, { score: null, reasons: ['批量'] }, settings.action, 'manual')) queued++; });
    if (btn) {
      btn.disabled = true;
      btn.textContent = '已加入慢速队列 ' + queued + ' 个';
    }
    updatePanel();
    pumpQueue();
  }

  const CELL_SEL = 'article[data-testid="tweet"], [data-testid="UserCell"], [data-testid="cellInnerDiv"]';
  function hasCandidateAncestor(cell) {
    for (let p = cell.parentElement; p; p = p.parentElement) {
      if (p.matches && p.matches(CELL_SEL)) return true;
    }
    return false;
  }
  function scan(root) {
    const r = root || document;
    if (r.nodeType === 1 && r.matches && r.matches(CELL_SEL) && !hasCandidateAncestor(r)) processCell(r);
    if (r.querySelectorAll) r.querySelectorAll(CELL_SEL).forEach((cell) => {
      if (!hasCandidateAncestor(cell)) processCell(cell);
    });
  }

  // 路由切换（X 是 SPA，不刷新页面就换会话）：清掉该页模板桶与未发出的队列条目。
  // 🔴 取消的判据是**完整 pathname**，不是模板分桶键。分桶键把 /home、/explore、
  //    /notifications 全折叠成 'home'，用它当判据的话，从首页跳到通知页不会取消任何东西 ——
  //    而用户看到的是「我已经离开那条推了」。
  function checkRoute() {
    if (location.pathname === currentPath) return;
    const prevBucket = currentBucket;
    currentPath = location.pathname;
    currentBucket = pageKey();
    if (prevBucket !== currentBucket) dropBucket(prevBucket);
    drainQueue('路由切换，未发出');
    evidenceRevision++;
    updatePanel();
  }

  // SPA 换页不一定伴随 DOM 变化去抖，所以除了 MutationObserver 还挂 history 钩子。
  function hookHistory() {
    if (typeof history === 'undefined' || !history) return;
    ['pushState', 'replaceState'].forEach((name) => {
      const original = history[name];
      if (typeof original !== 'function') return;
      history[name] = function () {
        const out = original.apply(this, arguments);
        try { checkRoute(); } catch (e) { /* 不能让导航因为我们而失败 */ }
        return out;
      };
    });
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('popstate', () => { try { checkRoute(); } catch (e) {} });
    }
  }

  // 设置一变（模式/动作/阈值），已经算过的卡片全部作废重判。
  function applySettingsChange() {
    saveSettings();
    if (settings.mode !== 'auto') {
      // 自动模式排的队，切回手动就不该再发出去 —— 用户切回手动的意思就是「别自己动手」。
      drainQueue('模式切回手动，未发出', (e) => e.kind === 'do' && e.origin === 'auto');
    }
    rerenderActionButtons();
    evidenceRevision++;
    rescanAllSeen();
    updatePanel();
  }

  function rescanAllSeen() {
    if (rescanning) return;
    rescanning = true;
    try {
      Array.from(seenCellsByHandle.values()).forEach((cells) => {
        Array.from(cells).forEach((cell) => {
          if (!cell || cell.isConnected === false) { cells.delete(cell); return; }
          processCell(cell);
        });
      });
    } finally { rescanning = false; }
  }

  // ============================================================
  // 面板
  // ============================================================
  let panel, noticeEl, modeBtn, actionBtn;
  function updatePanel() {
    if (!panel) return;
    const count = panel.querySelector('.xspam-count');
    if (count) count.textContent = actionedCount;
    const batch = panel.querySelector('#xspam-block-marked');
    if (batch) {
      const n = visibleFlaggedHandles().length;
      // 说明：动作为「静音」时标成「静音/屏蔽本页疑似(n)」，标题里写清本次真正会执行哪一个。
      const prefix = settings.action === 'mute' ? '静音/屏蔽' : '屏蔽';
      batch.textContent = prefix + '本页疑似(' + n + ')';
      batch.title = '本次动作：' + ACTION_LABEL[settings.action] + '。只处理当前页面已经被标红的疑似垃圾账号；每次最多 '
        + BATCH_BLOCK_CLICK_CAP + ' 个，慢速执行，不处理未命中的普通账号。';
      batch.disabled = n === 0;
    }
    if (modeBtn) modeBtn.textContent = '模式:' + (settings.mode === 'auto' ? '自动' : '手动');
    if (actionBtn) actionBtn.textContent = '动作:' + ACTION_LABEL[settings.action];
    if (noticeEl) {
      const bits = [];
      if (queuePaused) bits.push('⏸ 已暂停：' + pauseReason);
      if (notice) bits.push(notice);
      if (ledgerEvicted) bits.push('更早的记录已不可撤销');
      if (!storageUsable()) bits.push('本地存储不可用，设置与账本只在本次会话有效');
      noticeEl.textContent = bits.join(' · ');
    }
  }

  function panelButton(id, text, title) {
    const b = document.createElement('button');
    b.id = id;
    b.textContent = text;
    if (title) b.title = title;
    b.style.cssText = 'display:inline-block;margin:6px 6px 0 0;background:#1d9bf0;color:#fff;border:none;font-size:12px;padding:4px 10px;border-radius:14px;cursor:pointer;font-weight:700;';
    return b;
  }

  function buildPanel() {
    const existing = document.getElementById('xspam-panel');
    if (existing) { panel = existing; return; }
    panel = document.createElement('div');
    panel.id = 'xspam-panel';
    panel.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:99999;background:#000;color:#fff;border:1px solid #2f3336;border-radius:12px;padding:8px 12px;font-size:12px;font-family:system-ui;box-shadow:0 2px 12px rgba(0,0,0,.4);max-width:280px;';
    panel.innerHTML = '🛡 已处理 <b class="xspam-count">0</b>';

    modeBtn = panelButton('xspam-mode', '模式:手动', '手动 = 只标红，你点了才动手；自动 = 命中独立信号就慢速自动处理（簇分不算数）');
    modeBtn.addEventListener('click', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      settings.mode = settings.mode === 'auto' ? 'mark' : 'auto';
      applySettingsChange();
    });
    actionBtn = panelButton('xspam-action', '动作:静音', '静音 = 轻，随时可撤销；屏蔽 = 重，会断掉互相关注关系');
    actionBtn.addEventListener('click', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      settings.action = settings.action === 'mute' ? 'block' : 'mute';
      applySettingsChange();
    });

    const batchBtn = document.createElement('button');
    batchBtn.id = 'xspam-block-marked';
    batchBtn.textContent = '屏蔽本页疑似(0)';
    batchBtn.style.cssText = 'display:block;margin-top:6px;background:#e0245e;color:#fff;border:none;font-size:12px;padding:4px 10px;border-radius:14px;cursor:pointer;font-weight:700;';
    batchBtn.addEventListener('click', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      actMarkedVisible(batchBtn);
    });

    const undoBtn = panelButton('xspam-undo', '撤销最近一条', '撤销本脚本记录为成功的最近一条。⚠️ 脚本无从得知你在它动手之前的状态：如果那个人你本来就静音/屏蔽过，这一撤会把原来那层关系也一并解除。');
    undoBtn.addEventListener('click', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      enqueueUndo();
    });
    const exportBtn = panelButton('xspam-export', '导出账本', '把账本导出成 JSON，便于复核误判');
    exportBtn.addEventListener('click', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      downloadJSON('x-spam-ledger.json', ledger);
    });

    noticeEl = document.createElement('div');
    noticeEl.className = 'xspam-notice';
    noticeEl.style.cssText = 'margin-top:6px;color:#ffd400;font-size:11px;line-height:1.4;';

    panel.appendChild(modeBtn);
    panel.appendChild(actionBtn);
    panel.appendChild(batchBtn);
    panel.appendChild(undoBtn);
    panel.appendChild(exportBtn);
    panel.appendChild(noticeEl);
    updatePanel();
    document.body.appendChild(panel);
  }

  // ===== 采集器：把"已屏蔽账号"列表抓成 JSON（真实正样本数据源）=====
  function onBlockedPage() { return /\/settings\/(blocked|blocked_all)/.test(location.pathname); }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function extractUserCell(cell) {
    const nameBlock = cell.querySelector('[data-testid="User-Name"]');
    let name = '', handle = '';
    if (nameBlock) {
      const txt = richText(nameBlock);
      const at = txt.match(/@(\w+)/); if (at) handle = at[1];
      name = txt.split('@')[0].replace(/\s+/g, ' ').trim();
    }
    // bio：cell 文本里去掉 名字/handle 行 与 按钮文案
    const lines = richText(cell).split('\n').map((s) => s.trim()).filter(Boolean);
    const bio = lines.filter((l) =>
      l !== name && !l.startsWith('@') &&
      !/^(Block(ed)?|Following|Follow|Unblock|拉黑|已?屏蔽|正在关注|关注|取消屏蔽)$/.test(l)
    ).join(' ');
    return { handle, name, bio };
  }

  function downloadJSON(filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a);
    if (typeof a.click === 'function') a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
  }

  async function harvestBlocked(btn) {
    const seen = new Map();
    let stagnant = 0;
    while (stagnant < 8) {
      document.querySelectorAll('[data-testid="UserCell"]').forEach((cell) => {
        const u = extractUserCell(cell);
        if (u.handle && !seen.has(u.handle)) seen.set(u.handle, u);
      });
      btn.textContent = '采集中… ' + seen.size;
      const before = seen.size;
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(900);
      if (seen.size === before) stagnant++; else stagnant = 0;   // 连续 8 次没新增 = 到底
    }
    const data = [...seen.values()];
    downloadJSON('x-blocklist.json', data);
    btn.textContent = '✓ 采集完成 ' + data.length + ' 个（已下载 x-blocklist.json）';
  }

  function ensureCollector() {
    if (!onBlockedPage() || document.getElementById('xspam-collector')) return;
    const b = document.createElement('button');
    b.id = 'xspam-collector';
    b.textContent = '📥 采集已屏蔽账号 → JSON';
    b.style.cssText = 'position:fixed;top:70px;right:16px;z-index:99999;background:#1d9bf0;color:#fff;border:none;font-size:13px;padding:8px 14px;border-radius:18px;cursor:pointer;font-weight:700;box-shadow:0 2px 12px rgba(0,0,0,.3);';
    b.addEventListener('click', () => { b.disabled = true; harvestBlocked(b); });
    document.body.appendChild(b);
  }

  function start() {
    buildPanel();
    ensureCollector();
    scan(document);
    // 事件驱动 + 去抖：只在 DOM 真的变化时扫，并把一连串变化合并成一次。
    // 闲置时一次都不跑；内容签名未变化的卡片会跳过。纯本地 DOM 读取，不发网络，与反爬虫无关。
    let pending = false;
    const schedule = () => { if (pending) return; pending = true; setTimeout(() => { pending = false; checkRoute(); scan(document); ensureCollector(); }, 300); };
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    hookHistory();
    console.log('[x-spam] v' + VERSION + ' 已启动（形态+行为+语义+模板聚类，事件驱动），阈值=' + settings.threshold
      + '，模式=' + (settings.mode === 'auto' ? '自动' : '手动')
      + '，动作=' + ACTION_LABEL[settings.action]);
  }

  if (document.body) start();
  else window.addEventListener('DOMContentLoaded', start);
})();
