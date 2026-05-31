// ==UserScript==
// @name         X 中文垃圾号识别 / 一键屏蔽 (形态+行为+语义)
// @namespace    https://github.com/vahnxu/x-spam-blocker
// @version      0.6.4
// @description  本地实时识别 X 上的中文色情/引流/搭讪垃圾号。不靠敏感词黑名单（那是军备竞赛），改为综合判据：自动生成 handle 形态 + 随机 emoji 沙拉 + 孤独搭讪语义 + 引流链接。浏览器本地跑，像广告拦截器一样轻。
// @author       vahnxu
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

  // 模式：'mark' = 只标红 + 「屏蔽」按钮，你点了才屏蔽（默认，最安全）
  //       'auto' = 自动屏蔽命中的号（看顺眼了再改）
  const VERSION = '0.6.4';
  const MODE = 'mark';

  // 命中总分达到这个阈值才算垃圾号（调高更保守、更不易误伤）
  const THRESHOLD = 5;

  const AUTO_BLOCK_MIN_GAP = 1500;   // 自动模式两次屏蔽最小间隔(ms)
  const AUTO_BLOCK_MAX_GAP = 3500;
  const AUTO_BLOCK_SESSION_CAP = 200;
  const MAX_TRACKED_HANDLES = 500;    // 只保留最近可见垃圾号的 DOM 引用，避免长时间浏览内存膨胀

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
  };

  // 露骨词（出现在名字或正文，命中 +explicit）
  const EXPLICIT = ['同城上门','上门服务','寻固炮','点击主页','点我主页','日泡平台','真人认证','秒约','可约','空降','外围','楼凤','裸聊','福利姬','涩涩','约炮','约啪','上门约','同城约','加我微信','资源群','线下真实','一对一裸'];
  // 名字软 token（搭讪/暗示，+nameSoft）
  const NAME_SOFT = ['涩','馋','约见','真实约见','身子','线上','指挥','寻欢','哥哥我要','调教','喂养','榨','骚'];
  // 孤独/搭讪语义短语（不是露骨词，关键词抓不全，这里只列高区分度的，+bait）
  const BAIT = ['想找你','想找人','找人聊','你在吗','谁救我','求靠谱','靠谱朋友','陪我','处对象','两个人更好','把孤独','一起把孤独','约吗','撩我','想脱单','找个人疼','找对象'];
  // 引流链接（+link）
  const LINK_PATTERNS = [/t\.me\//i, /\b[a-z0-9]{2,12}\.(top|xyz|vip|cyou|icu|club|live|cc|shop|fun|link|life)\b/i];
  // 全国城市名堆叠：中文批量垃圾号常用"城市矩阵 + 同城/上门"铺词，普通真人短回复很少这样写。
  const CITY_TERMS = ['北京','上海','广州','深圳','天津','重庆','成都','杭州','南京','苏州','武汉','西安','郑州','长沙','合肥','济南','青岛','宁波','东莞','佛山','无锡','常州','南通','绍兴','贵阳','南宁','石家庄','哈尔滨','长春','厦门','大连','沈阳','福州','太原','温州','南昌','徐州','烟台','潍坊','扬州','洛阳','保定','海口','金华','兰州','乌鲁木齐','临沂','湖州','盐城','唐山','济宁','廊坊','泰州','赣州','呼和浩特','镇江','芜湖','汕头','邯郸','江门','淄博','银川','南阳','淮安','绵阳','连云港','阜阳','新乡','咸阳','三亚','威海','桂林','漳州','遵义','宜昌','宿迁','沧州','衡阳','柳州','襄阳','莆田'];
  const CONTACT_CUES = ['点击即可联系','点击联系','主页联系','私信联系','预约','服务复制','加薇','佳薇','QQ裙','qq群','TG：','TG:', '电报', '大圈品质','附近喝茶','商务接待','学生兼职','同城资源','空姐模特'];
  const REFERRAL_CUES = ['太涩','太色','顶不住','主页能打','她主页','她的主页','能打✈','打✈','打飞机','已探路','探路','花样多','体制内老师','专业牵线','牵线','1-5线覆盖','看主页'];
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

  const BEARER = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

  const autoQueuedHandles = new Set();
  const flaggedCellsByHandle = new Map();
  let blockedCount = 0, autoBlockedThisSession = 0;
  const autoQueue = []; let autoBusy = false;

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
    const compact = text.replace(/\s+/g, '');
    if (!/@\w+/.test(text)) return false;
    const cueHits = countTermHits(compact, REFERRAL_CUES);
    if (cueHits >= 2) return true;
    if (cueHits >= 1 && MENTION_CODE.test(text)) return true;
    return false;
  }

  function cellSignature(name, handle, text) {
    return handle.toLowerCase() + ':' + hashText(name + '\n' + text);
  }

  // 综合评分：形态 + 行为(emoji沙拉) + 语义(软token/bait) + 露骨词 + 链接
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

  function extract(cell) {
    const nameBlock = cell.querySelector('[data-testid="User-Name"]');
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
    const textEl = cell.querySelector('[data-testid="tweetText"]');
    const text = textEl ? richText(textEl) : '';
    return { name, handle, text };
  }

  async function blockUser(screenName) {
    const ct0 = getCookie('ct0');
    if (!ct0) { console.warn('[x-spam] 未登录(无 ct0)'); return false; }
    try {
      const res = await fetch('https://x.com/i/api/1.1/blocks/create.json', {
        method: 'POST',
        headers: {
          'authorization': BEARER, 'x-csrf-token': ct0,
          'x-twitter-active-user': 'yes', 'x-twitter-auth-type': 'OAuth2Session',
          'content-type': 'application/x-www-form-urlencoded',
        },
        credentials: 'include',
        body: 'screen_name=' + encodeURIComponent(screenName) + '&skip_status=1',
      });
      if (res.ok) { blockedCount++; updatePanel(); return true; }
      console.warn('[x-spam] 屏蔽失败', screenName, res.status); return false;
    } catch (e) { console.warn('[x-spam] 屏蔽异常', screenName, e); return false; }
  }

  function pumpAutoQueue() {
    if (autoBusy || !autoQueue.length || autoBlockedThisSession >= AUTO_BLOCK_SESSION_CAP) return;
    autoBusy = true;
    const { handle, cell } = autoQueue.shift();
    blockUser(handle).then((ok) => {
      if (ok) { autoBlockedThisSession++; markHandleBlocked(handle, cell); }
      const gap = AUTO_BLOCK_MIN_GAP + Math.floor((AUTO_BLOCK_MAX_GAP - AUTO_BLOCK_MIN_GAP) * Math.random());
      setTimeout(() => { autoBusy = false; pumpAutoQueue(); }, gap);
    });
  }

  function rememberFlaggedCell(handle, cell) {
    const key = handle.toLowerCase();
    if (!flaggedCellsByHandle.has(key) && flaggedCellsByHandle.size >= MAX_TRACKED_HANDLES) {
      flaggedCellsByHandle.delete(flaggedCellsByHandle.keys().next().value);
    }
    if (!flaggedCellsByHandle.has(key)) flaggedCellsByHandle.set(key, new Set());
    const cells = flaggedCellsByHandle.get(key);
    cells.forEach((tracked) => { if (tracked !== cell && tracked.isConnected === false) cells.delete(tracked); });
    cells.add(cell);
  }

  function markHandleBlocked(handle, fallbackCell) {
    const key = handle.toLowerCase();
    const cells = flaggedCellsByHandle.get(key) || new Set([fallbackCell]);
    cells.forEach((cell) => { if (cell && cell.isConnected !== false) markCellBlocked(cell, handle); });
  }

  function markCellSpam(cell, handle, reasons) {
    if (cell.dataset.xspam) return;
    cell.dataset.xspam = '1';
    cell.style.outline = '2px solid #e0245e';
    cell.style.outlineOffset = '-2px';
    if (getComputedStyle(cell).position === 'static') cell.style.position = 'relative';

    const badge = document.createElement('div');
    badge.textContent = '⚠ 疑似垃圾号';
    badge.style.cssText = 'position:absolute;top:6px;right:8px;z-index:9;background:#e0245e;color:#fff;font-size:11px;padding:2px 6px;border-radius:6px;font-weight:700;';
    const btn = document.createElement('button');
    btn.textContent = '屏蔽'; btn.title = '命中: ' + reasons.join(', ');
    btn.style.cssText = 'position:absolute;top:30px;right:8px;z-index:9;background:#e0245e;color:#fff;border:none;font-size:12px;padding:4px 10px;border-radius:14px;cursor:pointer;font-weight:700;';
    btn.addEventListener('click', async (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      btn.textContent = '屏蔽中…'; btn.disabled = true;
      const ok = await blockUser(handle);
      if (ok) markHandleBlocked(handle, cell); else btn.textContent = '失败';
    });
    cell.appendChild(badge); cell.appendChild(btn);
  }

  function markCellBlocked(cell, handle) {
    cell.style.opacity = '0.35';
    let tag = cell.querySelector('.xspam-blocked-tag');
    if (!tag) {
      tag = document.createElement('div');
      tag.className = 'xspam-blocked-tag';
      tag.textContent = '✓ 已屏蔽 @' + handle;
      tag.style.cssText = 'position:absolute;top:6px;right:8px;z-index:9;background:#536471;color:#fff;font-size:11px;padding:2px 6px;border-radius:6px;font-weight:700;';
      if (getComputedStyle(cell).position === 'static') cell.style.position = 'relative';
      cell.appendChild(tag);
    }
  }

  function processCell(cell) {
    const { name, handle, text } = extract(cell);
    if (!handle) return;                       // 内容还没渲染完，下次扫描再重试
    const signature = cellSignature(name, handle, text);
    if (cell.dataset && cell.dataset.xspamSignature === signature) return;
    if (cell.dataset) cell.dataset.xspamSignature = signature;
    const key = handle.toLowerCase();

    const { s, reasons } = score(name, handle, text);
    if (s < THRESHOLD) return;

    rememberFlaggedCell(handle, cell);
    markCellSpam(cell, handle, reasons);
    if (MODE === 'auto' && !autoQueuedHandles.has(key)) {
      autoQueuedHandles.add(key);
      autoQueue.push({ handle, cell });
      pumpAutoQueue();
    }
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

  let panel;
  function updatePanel() { if (panel) panel.querySelector('.xspam-count').textContent = blockedCount; }
  function buildPanel() {
    const existing = document.getElementById('xspam-panel');
    if (existing) { panel = existing; return; }
    panel = document.createElement('div');
    panel.id = 'xspam-panel';
    panel.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:99999;background:#000;color:#fff;border:1px solid #2f3336;border-radius:12px;padding:8px 12px;font-size:12px;font-family:system-ui;box-shadow:0 2px 12px rgba(0,0,0,.4);';
    panel.innerHTML = '🛡 已屏蔽 <b class="xspam-count">0</b> · 模式:' + (MODE === 'auto' ? '自动' : '手动');
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
    a.href = url; a.download = filename; document.body.appendChild(a); a.click();
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
    const schedule = () => { if (pending) return; pending = true; setTimeout(() => { pending = false; scan(document); ensureCollector(); }, 300); };
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    console.log('[x-spam] v' + VERSION + ' 已启动（形态+行为+语义，事件驱动），阈值=' + THRESHOLD + '，模式=' + MODE);
  }

  if (document.body) start();
  else window.addEventListener('DOMContentLoaded', start);
})();
