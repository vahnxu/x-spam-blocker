// ==UserScript==
// @name         X 中文垃圾号识别 / 一键屏蔽 (同城上门·寻固炮类)
// @namespace    https://github.com/vahnxu/x-spam-blocker
// @version      0.1.0
// @description  本地实时识别 X 上的中文色情/引流垃圾号（同城上门、寻固炮、点击主页、t.me 引流等），标红并支持一键/自动屏蔽。不用 AI，浏览器本地跑，像广告拦截器一样轻。
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

  // 模式：
  //   'mark' = 只标红 + 给一个「屏蔽」按钮，你点了才屏蔽（默认，最安全，先观察准不准）
  //   'auto' = 自动屏蔽命中的号（看顺眼了再改成这个）
  const MODE = 'mark';

  // 命中分数达到这个阈值才算垃圾号（越高越保守、越不容易误伤）
  const THRESHOLD = 3;

  // 自动模式下，两次屏蔽之间的随机间隔（毫秒），避免操作太快被 X 风控
  const AUTO_BLOCK_MIN_GAP = 1500;
  const AUTO_BLOCK_MAX_GAP = 3500;
  // 自动模式下，单次会话最多自动屏蔽多少个（防止误判时大规模误伤）
  const AUTO_BLOCK_SESSION_CAP = 200;

  // —— 强特征关键词（出现在「名字」或「正文」里，命中一个 +3，基本一击必杀）——
  const STRONG_KEYWORDS = [
    '同城上门', '上门服务', '寻固炮', '约炮', '约啪', '点击主页', '点我主页',
    '想找我的宝宝', '日泡平台', '真人认证', '秒约', '可约', '空降', '外围',
    '楼凤', '裸聊', '福利姬', '涩涩', '骚货', '加我微信', '加V看', '一对一裸',
    '线下真实', '资源群', '上门约', '同城约',
  ];

  // —— 弱特征关键词（出现一个 +1，需要凑够分数才算）——
  const WEAK_KEYWORDS = [
    '同城', '上门', '主页', '安全靠谱', '隐私保护', '浮力', '加微', '加V',
    '看主页', '私聊', '小号', '禁言', '飞机', '电报',
  ];

  // —— 可疑链接（命中 +2）——
  const LINK_PATTERNS = [
    /t\.me\//i,                                   // 电报引流
    /\b[a-z0-9]{2,10}\.(top|xyz|vip|cyou|icu|club|live|cc|shop|fun)\b/i, // 短引流域名
  ];

  // —— 用户名「英文名/词 + 一长串数字」（命中 +1，单独不足以屏蔽）——
  const HANDLE_DIGITS_RE = /^[A-Za-z][A-Za-z._]*\d{6,}$/;

  // —— 装饰性 emoji，垃圾号爱用（命中 +1）——
  const DECOR_EMOJI_RE = /[🌸✈️💕❤️🔥👇👉🍑💋🌹🉑️🆔]/u;

  // ============================================================
  // ② 以下是逻辑，普通用户不用动
  // ============================================================

  // X 网页客户端公开 bearer token（不是你的密码，是 X 官方 JS 里写死的公共 client token；
  // 真正的身份验证靠你浏览器里的登录 cookie）
  const BEARER = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

  const processed = new Set();   // 已处理过的 handle，避免重复扫描
  let blockedCount = 0;
  let autoBlockedThisSession = 0;
  const autoQueue = [];
  let autoBusy = false;

  function getCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }

  // 调用 X 内部 1.1 接口屏蔽（不需要打开菜单点击，直接走网络请求）
  async function blockUser(screenName) {
    const ct0 = getCookie('ct0');
    if (!ct0) { console.warn('[x-spam] 找不到 ct0 cookie，可能未登录'); return false; }
    try {
      const res = await fetch('https://x.com/i/api/1.1/blocks/create.json', {
        method: 'POST',
        headers: {
          'authorization': BEARER,
          'x-csrf-token': ct0,
          'x-twitter-active-user': 'yes',
          'x-twitter-auth-type': 'OAuth2Session',
          'content-type': 'application/x-www-form-urlencoded',
        },
        credentials: 'include',
        body: 'screen_name=' + encodeURIComponent(screenName) + '&skip_status=1',
      });
      if (res.ok) {
        blockedCount++;
        updatePanel();
        return true;
      }
      console.warn('[x-spam] 屏蔽失败', screenName, res.status);
      return false;
    } catch (e) {
      console.warn('[x-spam] 屏蔽异常', screenName, e);
      return false;
    }
  }

  function pumpAutoQueue() {
    if (autoBusy) return;
    if (autoQueue.length === 0) return;
    if (autoBlockedThisSession >= AUTO_BLOCK_SESSION_CAP) return;
    autoBusy = true;
    const { handle, cell } = autoQueue.shift();
    blockUser(handle).then((ok) => {
      if (ok) {
        autoBlockedThisSession++;
        markCellBlocked(cell, handle);
      }
      const gap = AUTO_BLOCK_MIN_GAP + Math.floor((AUTO_BLOCK_MAX_GAP - AUTO_BLOCK_MIN_GAP) * Math.random());
      setTimeout(() => { autoBusy = false; pumpAutoQueue(); }, gap);
    });
  }

  // 对一段文本打分
  function score(name, text) {
    const hay = (name + ' ' + text);
    let s = 0;
    const reasons = [];
    for (const k of STRONG_KEYWORDS) if (hay.includes(k)) { s += 3; reasons.push('强:' + k); }
    for (const k of WEAK_KEYWORDS)   if (hay.includes(k)) { s += 1; reasons.push('弱:' + k); }
    for (const re of LINK_PATTERNS)  if (re.test(hay))     { s += 2; reasons.push('链接'); break; }
    if (DECOR_EMOJI_RE.test(name))   { s += 1; reasons.push('emoji'); }
    return { s, reasons };
  }

  // 从一个 cell 里抽出 显示名 / handle / 正文
  function extract(cell) {
    const nameBlock = cell.querySelector('[data-testid="User-Name"]');
    let name = '', handle = '';
    if (nameBlock) {
      const txt = nameBlock.innerText || '';
      const at = txt.match(/@(\w+)/);
      if (at) handle = at[1];
      name = txt.split('@')[0].replace(/\s+/g, ' ').trim();
    }
    if (!handle) {
      // 退路：找 profile 链接
      const a = cell.querySelector('a[role="link"][href^="/"]');
      if (a) {
        const m = a.getAttribute('href').match(/^\/(\w+)$/);
        if (m) handle = m[1];
      }
    }
    const textEl = cell.querySelector('[data-testid="tweetText"]');
    const text = textEl ? (textEl.innerText || '') : (cell.innerText || '');
    return { name, handle, text };
  }

  function markCellSpam(cell, handle, reasons) {
    if (cell.dataset.xspam) return;
    cell.dataset.xspam = '1';
    cell.style.outline = '2px solid #e0245e';
    cell.style.outlineOffset = '-2px';

    const badge = document.createElement('div');
    badge.textContent = '⚠ 疑似垃圾号';
    badge.style.cssText = 'position:absolute;top:6px;right:8px;z-index:9;background:#e0245e;color:#fff;font-size:11px;padding:2px 6px;border-radius:6px;font-weight:700;';

    const btn = document.createElement('button');
    btn.textContent = '屏蔽';
    btn.title = '命中: ' + reasons.join(', ');
    btn.style.cssText = 'position:absolute;top:30px;right:8px;z-index:9;background:#e0245e;color:#fff;border:none;font-size:12px;padding:4px 10px;border-radius:14px;cursor:pointer;font-weight:700;';
    btn.addEventListener('click', async (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      btn.textContent = '屏蔽中…'; btn.disabled = true;
      const ok = await blockUser(handle);
      if (ok) markCellBlocked(cell, handle);
      else { btn.textContent = '失败'; }
    });

    if (getComputedStyle(cell).position === 'static') cell.style.position = 'relative';
    cell.appendChild(badge);
    cell.appendChild(btn);
  }

  function markCellBlocked(cell, handle) {
    cell.style.opacity = '0.35';
    const old = cell.querySelector('button[data-xspam-btn]');
    cell.querySelectorAll('div,button').forEach(() => {});
    // 简单覆盖一个“已屏蔽”标记
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
    if (!handle) return;
    const key = handle.toLowerCase();
    if (processed.has(key)) return;

    const { s, reasons } = score(name, text);
    // 加上 handle 形态特征
    let total = s;
    if (HANDLE_DIGITS_RE.test(handle)) { total += 1; reasons.push('handle数字'); }

    if (total < THRESHOLD) return;     // 不够分，放过（保护误伤）
    processed.add(key);

    if (MODE === 'auto') {
      markCellSpam(cell, handle, reasons);
      autoQueue.push({ handle, cell });
      pumpAutoQueue();
    } else {
      markCellSpam(cell, handle, reasons);
    }
  }

  function scan(root) {
    const cells = (root || document).querySelectorAll(
      'article[data-testid="tweet"], [data-testid="UserCell"], [data-testid="cellInnerDiv"]'
    );
    cells.forEach(processCell);
  }

  // —— 浮动计数面板 ——
  let panel;
  function updatePanel() {
    if (!panel) return;
    panel.querySelector('.xspam-count').textContent = blockedCount;
  }
  function buildPanel() {
    panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:99999;background:#000;color:#fff;border:1px solid #2f3336;border-radius:12px;padding:8px 12px;font-size:12px;font-family:system-ui;box-shadow:0 2px 12px rgba(0,0,0,.4);';
    panel.innerHTML = '🛡 已屏蔽 <b class="xspam-count">0</b> · 模式:' + (MODE === 'auto' ? '自动' : '手动');
    document.body.appendChild(panel);
  }

  // —— 启动 ——
  function start() {
    buildPanel();
    scan(document);
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1) scan(n);
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
    console.log('[x-spam] 已启动，模式=' + MODE + '，阈值=' + THRESHOLD);
  }

  if (document.body) start();
  else window.addEventListener('DOMContentLoaded', start);
})();
