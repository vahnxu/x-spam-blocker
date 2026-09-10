#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const USERSCRIPT_PATH = path.join(ROOT, 'x-spam-blocker.user.js');
const FIXTURE_PATH = path.join(ROOT, 'test', 'fixture.html');
const USERSCRIPT_SOURCE = fs.readFileSync(USERSCRIPT_PATH, 'utf8');
const METADATA_VERSION = (USERSCRIPT_SOURCE.match(/@version\s+([^\n]+)/) || [])[1]?.trim();

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

class FakeText {
  constructor(text, ownerDocument) {
    this.nodeType = 3;
    this.textContent = text;
    this.ownerDocument = ownerDocument;
  }
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.childNodes = [];
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.listeners = {};
    this.className = '';
    this.id = '';
    this.disabled = false;
    this._textContent = '';
    this._innerHTML = '';
  }

  appendChild(node) {
    if (typeof node === 'string') node = new FakeText(node, this.ownerDocument);
    node.parentNode = this;
    if (!node.ownerDocument) node.ownerDocument = this.ownerDocument;
    this.childNodes.push(node);
    if (node.nodeType === 1) this.children.push(node);
    return node;
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.childNodes = this.parentNode.childNodes.filter((node) => node !== this);
    this.parentNode.children = this.parentNode.children.filter((node) => node !== this);
    this.parentNode = null;
  }

  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'id') this.id = String(value);
    if (name === 'class') this.className = String(value);
  }

  getAttribute(name) {
    if (name === 'id') return this.id || null;
    if (name === 'class') return this.className || null;
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }

  addEventListener(type, handler) {
    this.listeners[type] = handler;
  }

  click() {
    if (this.listeners.click) this.listeners.click({ preventDefault() {}, stopPropagation() {} });
  }

  matches(selector) {
    return selector.split(',').some((part) => this.matchesOne(part.trim()));
  }

  matchesOne(selector) {
    if (selector === 'article[data-testid="tweet"]') {
      return this.tagName === 'ARTICLE' && this.getAttribute('data-testid') === 'tweet';
    }
    if (selector === '[data-testid="UserCell"]') return this.getAttribute('data-testid') === 'UserCell';
    if (selector === '[data-testid="cellInnerDiv"]') return this.getAttribute('data-testid') === 'cellInnerDiv';
    if (selector === '[data-testid="User-Name"]') return this.getAttribute('data-testid') === 'User-Name';
    if (selector === '[data-testid="tweetText"]') return this.getAttribute('data-testid') === 'tweetText';
    if (selector === 'a[role="link"][href^="/"]') {
      return this.tagName === 'A' && this.getAttribute('role') === 'link' && (this.getAttribute('href') || '').startsWith('/');
    }
    if (selector === 'article') return this.tagName === 'ARTICLE';
    if (selector === '[data-testid="quoteTweet"]') return this.getAttribute('data-testid') === 'quoteTweet';
    if (selector === 'div[role="link"][tabindex="0"]') {
      return this.tagName === 'DIV' && this.getAttribute('role') === 'link' && this.getAttribute('tabindex') === '0';
    }
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    return false;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const out = [];
    const visit = (node) => {
      if (node.nodeType !== 1) return;
      if (node.matches(selector)) out.push(node);
      node.childNodes.forEach(visit);
    };
    this.childNodes.forEach(visit);
    return out;
  }

  set textContent(value) {
    this.childNodes = [];
    this.children = [];
    this._textContent = String(value);
    if (value !== '') this.appendChild(new FakeText(String(value), this.ownerDocument));
  }

  get textContent() {
    if (this.childNodes.length === 0) return this._textContent;
    return this.childNodes.map((node) => node.textContent || '').join('');
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    this.childNodes = [];
    this.children = [];
    if (value.includes('xspam-count')) {
      const count = this.ownerDocument.createElement('b');
      count.className = 'xspam-count';
      count.textContent = '0';
      this.appendChild(count);
    }
  }

  get innerHTML() {
    return this._innerHTML;
  }
}

class FakeDocument {
  constructor(pathname = '/home') {
    this.nodeType = 9;
    this.location = { pathname };
    this.cookie = 'ct0=test-csrf';
    this.defaultView = {
      getComputedStyle(node) {
        if (node.tagName === 'ARTICLE' || node.tagName === 'DIV') return { display: 'block' };
        if (node.tagName === 'BR') return { display: 'inline' };
        return { display: 'inline' };
      },
    };
    this.body = this.createElement('body');
    this.documentElement = this.createElement('html');
    this.documentElement.scrollHeight = 2000;
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  createTextNode(text) {
    return new FakeText(text, this);
  }

  querySelector(selector) {
    if (this.body.matches(selector)) return this.body;
    return this.body.querySelector(selector);
  }

  querySelectorAll(selector) {
    const out = [];
    if (this.body.matches(selector)) out.push(this.body);
    return out.concat(this.body.querySelectorAll(selector));
  }

  getElementById(id) {
    if (this.body.id === id) return this.body;
    return this.body.querySelector('#' + id);
  }
}

function appendTextWithBreaks(doc, parent, value) {
  const parts = String(value).split('\n');
  parts.forEach((part, index) => {
    if (part) parent.appendChild(doc.createTextNode(part));
    if (index < parts.length - 1) parent.appendChild(doc.createElement('br'));
  });
}

function makeTweetCell(doc, { name, handle, text }) {
  const cell = doc.createElement('article');
  cell.setAttribute('data-testid', 'tweet');

  const nameBlock = doc.createElement('div');
  nameBlock.setAttribute('data-testid', 'User-Name');
  const nameSpan = doc.createElement('span');
  appendTextWithBreaks(doc, nameSpan, name);
  const handleSpan = doc.createElement('span');
  appendTextWithBreaks(doc, handleSpan, '@' + handle);
  nameBlock.appendChild(nameSpan);
  nameBlock.appendChild(handleSpan);
  cell.appendChild(nameBlock);

  if (text !== undefined) {
    const textEl = doc.createElement('div');
    textEl.setAttribute('data-testid', 'tweetText');
    appendTextWithBreaks(doc, textEl, text);
    cell.appendChild(textEl);
  }

  return cell;
}

function addTweetText(doc, cell, text) {
  const textEl = doc.createElement('div');
  textEl.setAttribute('data-testid', 'tweetText');
  appendTextWithBreaks(doc, textEl, text);
  cell.appendChild(textEl);
}

// 可编程 localStorage：既能预置初始值（测设置持久化），也能整体抛错（测存储不可用）。
function makeStorage(initial, opts = {}) {
  const map = new Map(Object.entries(initial || {}).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return {
    map,
    getItem(key) {
      if (opts.throws) throw new Error('storage denied');
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      if (opts.throws) throw new Error('storage denied');
      if ((opts.throwOnSet || []).indexOf(key) >= 0) throw new Error('storage denied for ' + key);
      map.set(key, String(value));
    },
    removeItem(key) { map.delete(key); },
    read(key) {
      const raw = map.get(key);
      return raw === undefined ? null : JSON.parse(raw);
    },
  };
}

function runUserscript(doc, options = {}) {
  const logs = [];
  const warnings = [];
  const fetches = [];
  const observers = [];
  const confirms = [];
  // 统一假时钟：定时器和 Date.now() 共用**同一条**时间轴。
  // 这一点是必须的 —— 脚本里「等到 nextAllowedAt 再发」的逻辑是拿 Date.now() 判的，
  // 如果定时器会推进而 Date.now() 不动，那条等待永远等不到头，测出来的就不是真语义。
  //   默认模式：setTimeout 立刻执行，但**同时把时钟往前拨 ms**（老用例照旧一口气跑完，
  //             而时间语义仍然自洽）。
  //   manualClock：定时器只入表，必须显式 advance(ms) 才跑。
  // ⚠️ 默认模式把时间压缩了：定时器在**登记的那一刻**就跑。压缩时间隐含的模型是
  //    「请求瞬间就回来了」，那么一个 20 秒的请求超时闸**本来就不该到期**。
  //    所以默认模式只自动触发短定时器（限速间隔那一档），长于 AUTO_FIRE_MAX_DELAY_MS 的
  //    看作长命守卫、不触发。要验证超时/共享节流这类先后关系，一律用 manualClock —— 
  //    那里所有定时器都按登记时刻排序触发，没有任何豁免。
  const AUTO_FIRE_MAX_DELAY_MS = 15000;   // > 最大限速间隔(12s)，< 请求超时闸(20s)
  const RealDate = Date;
  const timers = [];
  let clockNow = RealDate.now();
  let timerSeq = 0;
  function currentMs() { return clockNow; }
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(currentMs());
      else super(...args);
    }
    static now() { return currentMs(); }
  }
  function fireDueTimers(target) {
    for (;;) {
      timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = timers[0];
      if (!next || next.at > target) break;
      timers.shift();
      clockNow = Math.max(clockNow, next.at);
      next.fn();
    }
  }
  const setTimeoutStub = (fn, ms) => {
    const delay = ms || 0;
    if (!options.manualClock) {
      if (delay > AUTO_FIRE_MAX_DELAY_MS) return ++timerSeq;   // 长命守卫：压缩时间下不到期
      clockNow += delay;
      fn();
      return 0;
    }
    const id = ++timerSeq;
    timers.push({ id, at: clockNow + delay, fn });
    return id;
  };
  const clearTimeoutStub = (id) => {
    const i = timers.findIndex((t) => t.id === id);
    if (i >= 0) timers.splice(i, 1);
  };
  function advance(ms) {
    const target = clockNow + ms;
    fireDueTimers(target);
    clockNow = Math.max(clockNow, target);
  }
  // 可编程 fetch：按顺序返回预设结果；用完后回落到 200 OK。
  // 注意：默认结果**不带** json()，老用例的微任务预算就是按那条链算出来的。
  const plan = (options.fetchResponses || []).slice();
  function abortError() {
    const err = new Error('The operation was aborted.');
    err.name = 'AbortError';
    return err;
  }
  const context = {
    document: doc,
    location: doc.location,
    window: {
      document: doc,
      location: doc.location,
      scrollTo() {},
    },
    console: {
      log: (...args) => logs.push(args.join(' ')),
      warn: (...args) => warnings.push(args.join(' ')),
    },
    confirm: (message) => {
      confirms.push(String(message));
      return options.confirmReturn !== false;
    },
    setTimeout: setTimeoutStub,
    clearTimeout: clearTimeoutStub,
    getComputedStyle: (node) => doc.defaultView.getComputedStyle(node),
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
      }
      observe() {
        observers.push(this.callback);
      }
    },
    Blob: class {},
    URL: {
      createObjectURL: () => 'blob:test',
      revokeObjectURL() {},
    },
    fetch: async (url, init = {}) => {
      fetches.push({ url, init });
      // 真实 fetch 对一个已经中止的 signal 一定是拒绝，不会给你一个「成功但已中止」的响应。
      if (init.signal && init.signal.aborted) throw abortError();
      const planned = plan.shift();
      if (!planned) return { ok: true, status: 200 };
      if (planned.error) throw new Error(planned.error);
      if (planned.explode) {
        const bad = {};
        Object.defineProperty(bad, 'ok', { get() { throw new Error('boom'); } });
        return bad;
      }
      if (planned.hang) {
        // 永不 resolve，只认 abort —— 模拟「连上了但对端不吭声」
        return new Promise((resolve, reject) => {
          const signal = init.signal;
          if (!signal) return;
          const onAbort = () => {
            const err = new Error('The operation was aborted.');
            err.name = 'AbortError';
            reject(err);
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort);
        });
      }
      const res = { ok: planned.ok !== false, status: planned.status || 200 };
      if (init.signal && init.signal.aborted) throw abortError();
      if (planned.body !== undefined) res.json = async () => planned.body;
      if (planned.hangJson) res.json = () => new Promise((resolve, reject) => {
        const signal = init.signal;
        if (!signal) return;
        signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        });
      });
      return res;
    },
    Date: FakeDate,
    AbortController,
  };
  if (options.storage) context.localStorage = options.storage;
  // history 桩：让脚本能挂 pushState/replaceState 钩子（X 是 SPA，换会话不一定伴随 DOM 去抖）
  const winListeners = {};
  context.history = {
    pushState(state, title, url) { if (url) doc.location.pathname = String(url); },
    replaceState(state, title, url) { if (url) doc.location.pathname = String(url); },
  };
  context.window.history = context.history;
  context.window.addEventListener = (type, fn) => {
    if (!winListeners[type]) winListeners[type] = [];
    winListeners[type].push(fn);
  };
  context.window.setTimeout = context.setTimeout;
  context.window.clearTimeout = context.clearTimeout;
  context.window.MutationObserver = context.MutationObserver;
  context.window.Blob = context.Blob;
  context.window.URL = context.URL;
  context.window.fetch = context.fetch;
  context.window.Date = FakeDate;
  context.window.AbortController = AbortController;
  context.window.confirm = context.confirm;
  if (options.storage) context.window.localStorage = options.storage;

  vm.runInNewContext(USERSCRIPT_SOURCE, context, { filename: USERSCRIPT_PATH });

  return {
    logs,
    warnings,
    fetches,
    confirms,
    advance,
    now: () => clockNow,
    pendingTimers: () => timers.length,
    // 走脚本自己挂的 history 钩子，而不是直接改 pathname —— 这样测的才是钩子本身
    pushState(pathname) { context.history.pushState({}, '', pathname); },
    fireWindow(type) { (winListeners[type] || []).forEach((fn) => fn({})); },
    triggerMutation() {
      observers.forEach((callback) => callback([]));
    },
  };
}

function isMarked(cell) {
  return cell.dataset.xspam === '1';
}

// 单卡上的「静音/屏蔽」按钮（title 里带命中理由）
function actionButton(cell) {
  return cell.children.find((child) => child.className === 'xspam-action-btn') || null;
}

function reasonsOf(cell) {
  const btn = actionButton(cell);
  return btn ? String(btn.title || '') : '';
}

function clickEl(el) {
  el.listeners.click({ preventDefault() {}, stopPropagation() {} });
}

async function drain(times = 40) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

// 手动时钟下把队列彻底跑完：每次延迟只能靠一次 advance 推动（Date.now() 不会跟着动），
// 所以要反复推几轮，而不是一次 advance 一个大数字。
async function settle(harness, ms = 20000, rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    harness.advance(ms);
    await drain();
  }
}

// 一条无关键词、无 emoji 沙拉的普通长句：只有「多个号说同一句」这一个信号
const SLOGAN = '今天天气真好我们一起去公园散步吧';

const REFERRAL_SPAM = '她太涩了v 我真顶不住 @kikicez 2j';
function referralSpamCell(doc, i) {
  return makeTweetCell(doc, {
    name: '短评引流' + i, handle: 'spam_referral_' + i, text: '她太涩了v 我真顶不住 @kikicez ' + i + 'j',
  });
}

// 真实 x.com 的嵌套方向：外层 cellInnerDiv，作者本人那条推的 article 在它里面。
function wrapInCellInnerDiv(doc, article) {
  const outer = doc.createElement('div');
  outer.setAttribute('data-testid', 'cellInnerDiv');
  outer.appendChild(article);
  return outer;
}

function attachQuote(doc, article, quotedText) {
  const quoteBox = doc.createElement('div');
  quoteBox.setAttribute('role', 'link');
  quoteBox.setAttribute('tabindex', '0');
  const el = doc.createElement('div');
  el.setAttribute('data-testid', 'tweetText');
  appendTextWithBreaks(doc, el, quotedText);
  quoteBox.appendChild(el);
  article.appendChild(quoteBox);
  return article;
}

function makeQuoteTweetCell(doc, author, quoted) {
  const cell = makeTweetCell(doc, author);
  const quoteBox = doc.createElement('div');
  quoteBox.setAttribute('role', 'link');
  quoteBox.setAttribute('tabindex', '0');
  const quotedName = doc.createElement('div');
  quotedName.setAttribute('data-testid', 'User-Name');
  appendTextWithBreaks(doc, quotedName, quoted.name + ' @' + quoted.handle);
  const quotedText = doc.createElement('div');
  quotedText.setAttribute('data-testid', 'tweetText');
  appendTextWithBreaks(doc, quotedText, quoted.text);
  quoteBox.appendChild(quotedName);
  quoteBox.appendChild(quotedText);
  cell.appendChild(quoteBox);
  return cell;
}

test('fixture loads the current userscript instead of embedding a stale copy', () => {
  const fixture = fs.readFileSync(FIXTURE_PATH, 'utf8');
  assert.match(fixture, /<script\s+src="\.\.\/x-spam-blocker\.user\.js"><\/script>/);
  assert.doesNotMatch(fixture, /==UserScript==/);
});

test('startup log reports the userscript metadata version', () => {
  const doc = new FakeDocument('/home');
  const harness = runUserscript(doc);
  assert.ok(METADATA_VERSION, 'metadata version is present');
  assert.ok(
    harness.logs.some((line) => line.includes('v' + METADATA_VERSION)),
    'startup log should include v' + METADATA_VERSION
  );
});

test('marks Chinese spam samples while leaving normal short replies unmarked', () => {
  const doc = new FakeDocument('/home');
  const spam = makeTweetCell(doc, {
    name: '土豆味的🥉桃子',
    handle: 'NatalieCom28302',
    text: '一个人养猫追剧emo，快成野生动物了，谁救我?\n🚜\n👶\n👀🍁🪐💎🐞🌐',
  });
  const human = makeTweetCell(doc, {
    name: 'Xi',
    handle: 'Xi9866289434386',
    text: '@grok 为什么少共情呢',
  });
  doc.body.appendChild(spam);
  doc.body.appendChild(human);

  runUserscript(doc);

  assert.equal(isMarked(spam), true);
  assert.equal(isMarked(human), false);
});

test('marks city-burst contact spam even when the handle does not look auto-generated', () => {
  const doc = new FakeDocument('/home');
  const spam = makeTweetCell(doc, {
    name: 'Vivekanand Pandey',
    handle: 'vivekananddssw',
    text: '绍兴南通常州贵阳上门南宁石家庄哈尔滨长春厦门大连沈阳合肥济南福州约炮无锡青岛宁波东莞佛山郑州西安同城苏州天津武汉重庆成都南京线下广州深圳潍坊太原温州外围长沙南昌学生徐州烟台北京\nList · 1 Member\n点击即可联系',
  });
  doc.body.appendChild(spam);

  runUserscript(doc);

  assert.equal(isMarked(spam), true);
});

test('marks lower-tier city-burst spam with obfuscated escort wording', () => {
  const doc = new FakeDocument('/home');
  const spam = makeTweetCell(doc, {
    name: '静静中山东区西区南区石岐街道畻美二',
    handle: 'us100_szn',
    text: '围炮约下妇线兼同少生外学职城\n徐州扬州洛阳保定潍坊海口金华兰州乌鲁木齐临沂湖州盐城唐山济宁廊坊泰州赣州呼和浩特镇江芜湖汕头邯郸江门淄博银川南阳淮安绵阳连云港阜阳新乡咸阳三亚威海桂林漳州遵义宜昌宿迁沧州衡阳柳州襄阳莆田\nList · 0 Members\n同城约啪',
  });
  doc.body.appendChild(spam);

  runUserscript(doc);

  assert.equal(isMarked(spam), true);
});

test('marks short mention-referral spam replies while preserving ordinary mentions', () => {
  const doc = new FakeDocument('/home');
  const samples = [
    makeTweetCell(doc, {
      name: 'mauro',
      handle: 'maurobrunov',
      text: '她太涩了v 我真顶不住 @kikicez 2j',
    }),
    makeTweetCell(doc, {
      name: 'Eli R.',
      handle: 'ElibethRC',
      text: '刷了半天的X s就她主页能打✈️了 @yuyuvcr 1e',
    }),
    makeTweetCell(doc, {
      name: 'Michelle',
      handle: 'teachvolleyball',
      text: '30+的n 体制内老师 已探路花样多 @riley_bark46966 1n',
    }),
    makeTweetCell(doc, {
      name: 'ESSOLA ETOA LOUIS Childéric',
      handle: 'EtoaEssola',
      text: 'sao货d 没人比她sao ❣️ @mengyyw 7s',
    }),
    makeTweetCell(doc, {
      name: 'Ceyda Mendes',
      handle: 'OneirophobiaC',
      text: '线下sao货没人比她sao @irmkrdn ^lt',
    }),
  ];
  const human = makeTweetCell(doc, {
    name: 'Normal Reply',
    handle: 'normalreply',
    text: '刷了半天的 X，终于找到 @grok 的正确用法了',
  });
  samples.forEach((cell) => doc.body.appendChild(cell));
  doc.body.appendChild(human);

  runUserscript(doc);

  samples.forEach((cell) => assert.equal(isMarked(cell), true));
  assert.equal(isMarked(human), false);
});

test('marks every visible duplicate occurrence of the same spam handle', () => {
  const doc = new FakeDocument('/home');
  const first = makeTweetCell(doc, {
    name: '茜茜爱吃🥉海鲜',
    handle: 'JenniferCh75881',
    text: '社畜下班空荡荡，求靠谱朋友一起吐槽生活。\n🤞\n🐜\n🥩\n🩻🌹🍄🔥',
  });
  const second = makeTweetCell(doc, {
    name: '茜茜爱吃🥉海鲜',
    handle: 'JenniferCh75881',
    text: '社畜下班空荡荡，求靠谱朋友一起吐槽生活。\n🤞\n🐜\n🥩\n🩻🌹🍄🔥',
  });
  doc.body.appendChild(first);
  doc.body.appendChild(second);

  runUserscript(doc);

  assert.equal(isMarked(first), true);
  assert.equal(isMarked(second), true);
});

test('batch button blocks every marked visible handle once', async () => {
  const doc = new FakeDocument('/home');
  const first = makeTweetCell(doc, {
    name: '短评引流一',
    handle: 'spam_referral_1',
    text: '她太涩了v 我真顶不住 @kikicez 2j',
  });
  const duplicate = makeTweetCell(doc, {
    name: '短评引流一',
    handle: 'spam_referral_1',
    text: '她太涩了v 我真顶不住 @kikicez 2j',
  });
  const second = makeTweetCell(doc, {
    name: '短评引流二',
    handle: 'spam_referral_2',
    text: '刷了半天的X s就她主页能打✈️了 @yuyuvcr 1e',
  });
  const human = makeTweetCell(doc, {
    name: 'Normal Reply',
    handle: 'normalreply',
    text: '刷了半天的 X，终于找到 @grok 的正确用法了',
  });
  [first, duplicate, second, human].forEach((cell) => doc.body.appendChild(cell));
  const harness = runUserscript(doc);
  const button = doc.getElementById('xspam-block-marked');

  assert.ok(button, 'batch block button should exist');
  assert.match(button.textContent, /屏蔽本页疑似\(2\)/);

  button.listeners.click({ preventDefault() {}, stopPropagation() {} });
  for (let i = 0; i < 8; i++) await Promise.resolve();

  const bodies = harness.fetches.map((item) => String(item.init.body));
  assert.equal(bodies.length, 2);
  assert.deepEqual(
    bodies.map((body) => decodeURIComponent(body.match(/screen_name=([^&]+)/)[1])).sort(),
    ['spam_referral_1', 'spam_referral_2']
  );
});

test('batch button requires confirmation and queues at most the conservative per-click cap', async () => {
  const doc = new FakeDocument('/home');
  for (let i = 0; i < 30; i++) {
    doc.body.appendChild(makeTweetCell(doc, {
      name: '短评引流' + i,
      handle: 'spam_referral_' + i,
      text: '她太涩了v 我真顶不住 @kikicez ' + i + 'j',
    }));
  }
  const harness = runUserscript(doc);
  const button = doc.getElementById('xspam-block-marked');

  assert.ok(button, 'batch block button should exist');
  assert.match(button.textContent, /屏蔽本页疑似\(30\)/);

  button.listeners.click({ preventDefault() {}, stopPropagation() {} });
  for (let i = 0; i < 160; i++) await Promise.resolve();

  assert.equal(harness.confirms.length, 1);
  assert.match(harness.confirms[0], /最多先处理 25 个/);
  assert.equal(harness.fetches.length, 25);
});

test('marks only the outer tweet cell when X nests cellInnerDiv inside article', () => {
  const doc = new FakeDocument('/home');
  const article = doc.createElement('article');
  article.setAttribute('data-testid', 'tweet');
  const inner = makeTweetCell(doc, {
    name: 'Paola Fajardo',
    handle: 'paola_faja32679',
    text: '大连保定湖州盐城同城泰州温州哈尔滨济宁阜阳临沂廊坊福州南昌潍坊外围沧州绍兴南阳赣州学生海口新乡约炮\n专注中高端质量',
  });
  inner.tagName = 'DIV';
  inner.setAttribute('data-testid', 'cellInnerDiv');
  article.appendChild(inner);
  doc.body.appendChild(article);

  runUserscript(doc);

  assert.equal(isMarked(article), true);
  assert.equal(isMarked(inner), false);
});

test('re-evaluates a cell when X fills tweet text after the handle renders', () => {
  const doc = new FakeDocument('/home');
  const delayed = makeTweetCell(doc, {
    name: '欣欣小狗🌹',
    handle: 'RossettiAn26333',
  });
  doc.body.appendChild(delayed);
  const harness = runUserscript(doc);
  assert.equal(isMarked(delayed), false);

  addTweetText(doc, delayed, '城市灯火万家，少一盏属于我的，想找你。\n😗\n😋🌙🎉🎈🌹🧢');
  harness.triggerMutation();

  assert.equal(isMarked(delayed), true);
});

test('injects the blocked-account collector on X blocked settings pages', () => {
  const doc = new FakeDocument('/settings/blocked_all');
  runUserscript(doc);
  const collector = doc.getElementById('xspam-collector');
  assert.ok(collector);
  assert.equal(collector.textContent, '📥 采集已屏蔽账号 → JSON');
});

test('promoted sao escort words mark no-mention spam when a second signal corroborates', () => {
  const doc = new FakeDocument('/home');
  // 无 @提及，但 sao货(+explicit 4) + 自动生成 handle 形态(+3) = 7 >= 阈值 → 命中
  const spam = makeTweetCell(doc, {
    name: 'Evelyn',
    handle: 'evelyn_vau7909',
    text: 'sao货ud没人比她sao❣️ 5d',
  });
  doc.body.appendChild(spam);
  runUserscript(doc);
  assert.equal(isMarked(spam), true);
});

test('a lone no-mention sao word stays unmarked (conservative: +explicit alone is below threshold)', () => {
  const doc = new FakeDocument('/home');
  // 只有 sao货(+4)，无 @提及、无第二旁证 → 低于阈值，不误伤吐槽垃圾号的真人
  const lone = makeTweetCell(doc, {
    name: 'Larissa Alencar',
    handle: 'LaAlencar',
    text: '又是 sao货 引流的，烦死了',
  });
  doc.body.appendChild(lone);
  runUserscript(doc);
  assert.equal(isMarked(lone), false);
});

// ===== v0.7.0：模板聚类 / 引用推文归属 / 设置持久化 / 账本 / 共享准入控制 =====

test('three shaped handles repeating one sentence get clustered and marked with 簇', () => {
  const doc = new FakeDocument('/vahnxu/status/1234567890');
  const cells = [
    makeTweetCell(doc, { name: 'Anna', handle: 'AnnaWhit28302', text: SLOGAN + '🌸 1e' }),
    makeTweetCell(doc, { name: 'Bella', handle: 'bella_lu7909', text: '今天天气真好，我们一起去公园散步吧🍀 2j' }),
    makeTweetCell(doc, { name: 'Cara', handle: 'CaraMio4839', text: '@somebody 今天天气真好！我们一起去公园散步吧 3k' }),
  ];
  cells.forEach((cell) => doc.body.appendChild(cell));

  runUserscript(doc);

  cells.forEach((cell) => assert.equal(isMarked(cell), true));
  cells.forEach((cell) => assert.match(reasonsOf(cell), /簇×3/));
});

test('normalization survives fullwidth punctuation, traditional homoglyphs and emoji', () => {
  const doc = new FakeDocument('/vahnxu/status/1234567890');
  const cells = [
    // 繁体同形字（貨/沒）走极小同形表
    makeTweetCell(doc, { name: 'Anna', handle: 'AnnaWhit28302', text: '这批貨沒有问题可以放心买' }),
    // 全角标点 + emoji + 尾码
    makeTweetCell(doc, { name: 'Bella', handle: 'bella_lu7909', text: '这批货没有问题，可以放心买！！！🌟 4f' }),
    // 全角空格 + 全角字母
    makeTweetCell(doc, { name: 'Cara', handle: 'CaraMio4839', text: '这批货　没有问题　可以放心买ＯＫ' }),
  ];
  cells.forEach((cell) => doc.body.appendChild(cell));

  runUserscript(doc);

  cells.forEach((cell) => assert.match(reasonsOf(cell), /簇×3/));
});

test('a single shaped handle saying the same sentence alone stays unmarked', () => {
  const doc = new FakeDocument('/vahnxu/status/1234567890');
  const lone = makeTweetCell(doc, { name: 'Anna', handle: 'AnnaWhit28302', text: SLOGAN + '🌸 1e' });
  doc.body.appendChild(lone);

  runUserscript(doc);

  assert.equal(isMarked(lone), false);
});

test('three shaped handles saying three different sentences do not cluster', () => {
  const doc = new FakeDocument('/vahnxu/status/1234567890');
  const cells = [
    makeTweetCell(doc, { name: 'Anna', handle: 'AnnaWhit28302', text: '今天天气真好我们一起去公园散步吧' }),
    makeTweetCell(doc, { name: 'Bella', handle: 'bella_lu7909', text: '昨晚看了那部老电影结尾很难忘' }),
    makeTweetCell(doc, { name: 'Cara', handle: 'CaraMio4839', text: '早饭吃了一碗面加一个鸡蛋很饱' }),
  ];
  cells.forEach((cell) => doc.body.appendChild(cell));

  runUserscript(doc);

  cells.forEach((cell) => assert.equal(isMarked(cell), false));
});

test('three ordinary handles repeating one sentence stay unmarked (cluster alone is not enough)', () => {
  const doc = new FakeDocument('/vahnxu/status/1234567890');
  const cells = [
    makeTweetCell(doc, { name: 'Anna', handle: 'annaday', text: SLOGAN }),
    makeTweetCell(doc, { name: 'Bella', handle: 'bellalu', text: SLOGAN }),
    makeTweetCell(doc, { name: 'Cara', handle: 'caramio', text: SLOGAN }),
  ];
  cells.forEach((cell) => doc.body.appendChild(cell));

  runUserscript(doc);

  cells.forEach((cell) => assert.equal(isMarked(cell), false));
});

test('auto mode marks a cluster for review but never enqueues on cluster points alone', async () => {
  const doc = new FakeDocument('/vahnxu/status/1234567890');
  const storage = makeStorage({ 'xspam.settings.v1': { mode: 'auto', action: 'mute', threshold: 5 } });
  const cells = [
    makeTweetCell(doc, { name: 'Anna', handle: 'AnnaWhit28302', text: SLOGAN + '🌸 1e' }),
    makeTweetCell(doc, { name: 'Bella', handle: 'bella_lu7909', text: SLOGAN + '🍀 2j' }),
    makeTweetCell(doc, { name: 'Cara', handle: 'CaraMio4839', text: SLOGAN + '🌙 3k' }),
  ];
  cells.forEach((cell) => doc.body.appendChild(cell));

  const harness = runUserscript(doc, { storage });
  await drain();

  cells.forEach((cell) => assert.equal(isMarked(cell), true));
  cells.forEach((cell) => assert.match(reasonsOf(cell), /簇×3/));
  assert.equal(harness.fetches.length, 0, 'cluster evidence must not authorise an automatic write');
});

test('spam quoted by a real person is not attributed to the quoting author', () => {
  const doc = new FakeDocument('/home');
  const quoting = makeQuoteTweetCell(
    doc,
    { name: 'Real Person', handle: 'realperson', text: '这条回复也太离谱了吧' },
    { name: '短评引流一', handle: 'spam_referral_1', text: '她太涩了v 我真顶不住 @kikicez 2j' }
  );
  // 更硬的一例：真人只转发不配文，卡片里**唯一**的 tweetText 就是被引用的垃圾话。
  // 老实现 querySelector('[data-testid="tweetText"]') 会直接抓到它并把真人定罪。
  const bareQuote = makeTweetCell(doc, { name: 'Quiet Person', handle: 'quietperson' });
  const quoteBox = doc.createElement('div');
  quoteBox.setAttribute('role', 'link');
  quoteBox.setAttribute('tabindex', '0');
  const quotedText = doc.createElement('div');
  quotedText.setAttribute('data-testid', 'tweetText');
  appendTextWithBreaks(doc, quotedText, '线下sao货没人比她sao @irmkrdn ^lt');
  quoteBox.appendChild(quotedText);
  bareQuote.appendChild(quoteBox);

  doc.body.appendChild(quoting);
  doc.body.appendChild(bareQuote);

  runUserscript(doc);

  assert.equal(isMarked(quoting), false);
  assert.equal(isMarked(bareQuote), false);
});

test('settings persist across restarts and invalid values fall back to defaults', () => {
  const saved = makeStorage({ 'xspam.settings.v1': { mode: 'auto', action: 'block', threshold: 7 } });
  const doc = new FakeDocument('/home');
  const harness = runUserscript(doc, { storage: saved });
  const line = harness.logs.find((l) => l.includes('[x-spam]'));
  assert.match(line, /模式=自动/);
  assert.match(line, /动作=屏蔽/);
  assert.match(line, /阈值=7/);

  const broken = makeStorage({ 'xspam.settings.v1': '{"mode":"AUTO","action":"nuke","threshold":"high"}' });
  const doc2 = new FakeDocument('/home');
  const harness2 = runUserscript(doc2, { storage: broken });
  const line2 = harness2.logs.find((l) => l.includes('[x-spam]'));
  assert.match(line2, /模式=手动/);
  assert.match(line2, /动作=静音/);
  assert.match(line2, /阈值=5/);
});

test('a throwing localStorage degrades to in-memory defaults instead of crashing', () => {
  const doc = new FakeDocument('/home');
  const harness = runUserscript(doc, { storage: makeStorage({}, { throws: true }) });
  assert.ok(harness.logs.some((l) => l.includes('[x-spam] v')));
  const noticeEl = doc.querySelector('.xspam-notice');
  assert.ok(noticeEl);
  assert.match(noticeEl.textContent, /本地存储不可用/);
});

test('the default action targets the mute endpoint, not the block endpoint', async () => {
  const doc = new FakeDocument('/home');
  const spam = makeTweetCell(doc, {
    name: '短评引流一', handle: 'spam_referral_1', text: '她太涩了v 我真顶不住 @kikicez 2j',
  });
  doc.body.appendChild(spam);
  const harness = runUserscript(doc, { storage: makeStorage({}) });

  clickEl(actionButton(spam));
  await drain();

  assert.equal(harness.fetches.length, 1);
  assert.match(harness.fetches[0].url, /\/i\/api\/1\.1\/mutes\/users\/create\.json$/);
});

test('ledger goes intent -> ok, keeps id_str, and undo calls the matching destroy endpoint', async () => {
  const doc = new FakeDocument('/home');
  const storage = makeStorage({});
  const spam = makeTweetCell(doc, {
    name: '短评引流一', handle: 'spam_referral_1', text: '她太涩了v 我真顶不住 @kikicez 2j',
  });
  doc.body.appendChild(spam);
  const harness = runUserscript(doc, {
    storage,
    fetchResponses: [
      { ok: true, status: 200, body: { id_str: '90210' } },
      { ok: true, status: 200, body: { id_str: '90210' } },
    ],
  });

  clickEl(actionButton(spam));
  let entries = storage.read('xspam.ledger.v1');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 'intent');
  assert.equal(entries[0].action, 'mute');
  assert.equal(entries[0].handle, 'spam_referral_1');

  await drain();
  entries = storage.read('xspam.ledger.v1');
  assert.equal(entries[0].status, 'ok');
  assert.equal(entries[0].userId, '90210');

  clickEl(doc.getElementById('xspam-undo'));
  await drain();

  assert.equal(harness.fetches.length, 2);
  assert.match(harness.fetches[1].url, /\/i\/api\/1\.1\/mutes\/users\/destroy\.json$/);
  // 用 user_id 而不是 screen_name：这个人可能已经改名，改了名 screen_name 就指向别人了
  assert.match(String(harness.fetches[1].init.body), /user_id=90210/);
  assert.doesNotMatch(String(harness.fetches[1].init.body), /screen_name=/);
  entries = storage.read('xspam.ledger.v1');
  assert.equal(entries[0].status, 'undone');
});

test('a failed attempt stays unrecoverable: undo refuses anything that is not ok', async () => {
  const doc = new FakeDocument('/home');
  const storage = makeStorage({});
  const spam = makeTweetCell(doc, {
    name: '短评引流一', handle: 'spam_referral_1', text: '她太涩了v 我真顶不住 @kikicez 2j',
  });
  doc.body.appendChild(spam);
  const harness = runUserscript(doc, { storage, fetchResponses: [{ ok: false, status: 500 }] });

  clickEl(actionButton(spam));
  await drain();
  assert.equal(storage.read('xspam.ledger.v1')[0].status, 'fail');

  clickEl(doc.getElementById('xspam-undo'));
  await drain();

  assert.equal(harness.fetches.length, 1, 'undo must not fire for a failed entry');
  assert.match(doc.querySelector('.xspam-notice').textContent, /没有可撤销/);
});

test('a 429 pauses the shared queue, drops unsent entries and never auto-resumes', async () => {
  const doc = new FakeDocument('/home');
  for (let i = 0; i < 4; i++) {
    doc.body.appendChild(makeTweetCell(doc, {
      name: '短评引流' + i, handle: 'spam_referral_' + i, text: '她太涩了v 我真顶不住 @kikicez ' + i + 'j',
    }));
  }
  const harness = runUserscript(doc, {
    manualClock: true,
    storage: makeStorage({}),
    fetchResponses: [{ ok: false, status: 429 }],
  });

  clickEl(doc.getElementById('xspam-block-marked'));
  await drain();

  assert.equal(harness.fetches.length, 1);
  harness.advance(120000);
  await drain();
  assert.equal(harness.fetches.length, 1, 'paused queue must not resume on its own');
  assert.match(doc.querySelector('.xspam-notice').textContent, /HTTP 429/);
});

test('a route change drops queue entries that have not been sent yet', async () => {
  const doc = new FakeDocument('/vahnxu/status/111');
  for (let i = 0; i < 4; i++) {
    doc.body.appendChild(makeTweetCell(doc, {
      name: '短评引流' + i, handle: 'spam_referral_' + i, text: '她太涩了v 我真顶不住 @kikicez ' + i + 'j',
    }));
  }
  const harness = runUserscript(doc, { manualClock: true, storage: makeStorage({}) });

  clickEl(doc.getElementById('xspam-block-marked'));
  await drain();
  assert.equal(harness.fetches.length, 1, 'first entry goes out immediately');

  doc.location.pathname = '/someone/status/999';
  harness.triggerMutation();
  harness.advance(300);            // 去抖窗口：路由检查在这里跑
  await drain();
  harness.advance(60000);          // 把慢速间隔整个走完
  await drain();

  assert.equal(harness.fetches.length, 1, 'unsent entries must be dropped on route change');
});

test('hourly attempt cap blocks further enqueues before any request is sent', async () => {
  const doc = new FakeDocument('/home');
  const recent = [];
  for (let i = 0; i < 40; i++) recent.push(Date.now() - i * 1000);
  const storage = makeStorage({ 'xspam.attempts.v1': recent });
  for (let i = 0; i < 3; i++) {
    doc.body.appendChild(makeTweetCell(doc, {
      name: '短评引流' + i, handle: 'spam_referral_' + i, text: '她太涩了v 我真顶不住 @kikicez ' + i + 'j',
    }));
  }
  const harness = runUserscript(doc, { storage });

  clickEl(doc.getElementById('xspam-block-marked'));
  await drain();

  assert.equal(harness.fetches.length, 0);
  assert.match(doc.querySelector('.xspam-notice').textContent, /每小时尝试上限/);
});

// ===== v0.7.0 复审修复：真实 DOM 嵌套 / 发出前准入 / 动作绑定 / 取消语义 =====

test('author text is used when X nests the tweet article inside cellInnerDiv', () => {
  const doc = new FakeDocument('/home');
  // 这是真实 x.com 的形状：扫描器拿到的是外层 cellInnerDiv，作者的 article 在它里面。
  const outer = wrapInCellInnerDiv(doc, makeTweetCell(doc, {
    name: '短评引流一', handle: 'spam_referral_1', text: REFERRAL_SPAM,
  }));
  doc.body.appendChild(outer);

  runUserscript(doc);

  assert.equal(isMarked(outer), true, 'author tweetText must still be readable through cellInnerDiv');
});

test('quoted spam is excluded even through the cellInnerDiv > article > quote nesting', () => {
  const doc = new FakeDocument('/home');
  const article = makeTweetCell(doc, { name: 'Real Person', handle: 'realperson', text: '这条回复也太离谱了吧' });
  attachQuote(doc, article, REFERRAL_SPAM);
  const outer = wrapInCellInnerDiv(doc, article);
  doc.body.appendChild(outer);

  runUserscript(doc);

  assert.equal(isMarked(outer), false);
});

test('auto mode does enqueue spam that carries independent signals (positive control)', async () => {
  const doc = new FakeDocument('/home');
  doc.body.appendChild(referralSpamCell(doc, 1));
  const harness = runUserscript(doc, {
    storage: makeStorage({ 'xspam.settings.v1': { mode: 'auto', action: 'mute', threshold: 5 } }),
  });
  await drain();

  assert.equal(harness.fetches.length, 1, 'independent-signal spam must still be actioned in auto mode');
  assert.match(harness.fetches[0].url, /mutes\/users\/create\.json$/);
});

test('settings saved through the panel controls survive a restart', () => {
  const storage = makeStorage({});
  const doc = new FakeDocument('/home');
  runUserscript(doc, { storage });
  clickEl(doc.getElementById('xspam-mode'));      // 手动 -> 自动
  clickEl(doc.getElementById('xspam-action'));    // 静音 -> 屏蔽

  const doc2 = new FakeDocument('/home');
  const harness2 = runUserscript(doc2, { storage });
  const line = harness2.logs.find((l) => l.includes('[x-spam]'));
  assert.match(line, /模式=自动/);
  assert.match(line, /动作=屏蔽/);
});

test('the attempt cap is enforced at dispatch, not just at enqueue', async () => {
  const doc = new FakeDocument('/home');
  const used = [];
  for (let i = 0; i < 39; i++) used.push(Date.now() - i * 1000);   // 39/40，入队时还没触顶
  const storage = makeStorage({ 'xspam.attempts.v1': used });
  for (let i = 0; i < 3; i++) doc.body.appendChild(referralSpamCell(doc, i));
  const harness = runUserscript(doc, { storage });

  clickEl(doc.getElementById('xspam-block-marked'));
  await drain(120);

  // 入队口放行了 3 个，但名额只剩 1 个 —— 差额必须在发出前被拦住。
  assert.equal(harness.fetches.length, 1);
  assert.match(doc.querySelector('.xspam-notice').textContent, /每小时尝试上限/);
});

test('switching mode back to 手动 cancels queued automatic entries', async () => {
  const doc = new FakeDocument('/home');
  const storage = makeStorage({ 'xspam.settings.v1': { mode: 'auto', action: 'mute', threshold: 5 } });
  for (let i = 0; i < 3; i++) doc.body.appendChild(referralSpamCell(doc, i));
  const harness = runUserscript(doc, { manualClock: true, storage });
  await drain();
  assert.equal(harness.fetches.length, 1, 'first auto entry goes out');

  clickEl(doc.getElementById('xspam-mode'));      // 自动 -> 手动

  // 🔴 同步作废：点下去的那一刻就该定性，而不是等排到它才发现。
  // （只有发出前那道重检的话，这里还会是 intent。）
  const atClick = storage.read('xspam.ledger.v1');
  assert.equal(atClick[1].status, 'fail');
  assert.match(atClick[1].note, /模式切回手动/);

  await settle(harness);
  assert.equal(harness.fetches.length, 1, 'remaining auto entries must not be sent');
  assert.equal(storage.read('xspam.ledger.v1')[0].status, 'ok');
});

test('another tab switching to 手动 stops queued auto entries at dispatch', async () => {
  const doc = new FakeDocument('/home');
  const storage = makeStorage({ 'xspam.settings.v1': { mode: 'auto', action: 'mute', threshold: 5 } });
  for (let i = 0; i < 3; i++) doc.body.appendChild(referralSpamCell(doc, i));
  const harness = runUserscript(doc, { manualClock: true, storage });
  await drain();
  assert.equal(harness.fetches.length, 1);

  // 另一个标签页把模式切回手动：本窗口的内存设置还是 auto，没有任何面板点击发生。
  storage.map.set('xspam.settings.v1', JSON.stringify({ mode: 'mark', action: 'mute', threshold: 5 }));
  await settle(harness);

  assert.equal(harness.fetches.length, 1, 'a mode switch in another tab must be honoured at dispatch');
  const entries = storage.read('xspam.ledger.v1');
  assert.equal(entries[1].status, 'fail');
  assert.match(entries[1].note, /模式切回手动/);
});

test('a card button keeps the action it was rendered with, and idle buttons re-render', async () => {
  const doc = new FakeDocument('/home');
  const storage = makeStorage({ 'xspam.dispatch.v1': { nextAllowedAt: Date.now() + 5000 } });
  const a = referralSpamCell(doc, 1);
  const b = referralSpamCell(doc, 2);
  doc.body.appendChild(a);
  doc.body.appendChild(b);
  const harness = runUserscript(doc, { manualClock: true, storage });

  assert.equal(actionButton(a).textContent, '静音');
  clickEl(actionButton(a));                       // 以「静音」入队，此刻还发不出去
  await drain();
  assert.equal(harness.fetches.length, 0);

  clickEl(doc.getElementById('xspam-action'));    // 面板切成「屏蔽」
  assert.equal(actionButton(b).textContent, '屏蔽', 'idle buttons follow the panel');
  assert.equal(actionButton(a).textContent, '已排队…', 'a queued button is not relabelled');

  // 重新渲染过的按钮，点下去必须真的执行它此刻写着的那个动作
  clickEl(actionButton(b));
  await settle(harness);

  assert.equal(harness.fetches.length, 2);
  assert.match(harness.fetches[0].url, /mutes\/users\/create\.json$/, 'A must use the action bound at click time');
  assert.match(harness.fetches[1].url, /blocks\/create\.json$/, 'B must do what its label now says');
});

test('cancelling an unsent undo leaves the original ok entry intact', async () => {
  const doc = new FakeDocument('/home');
  const storage = makeStorage({});
  const spam = referralSpamCell(doc, 1);
  doc.body.appendChild(spam);
  const harness = runUserscript(doc, { manualClock: true, storage });

  clickEl(actionButton(spam));
  await drain();
  assert.equal(storage.read('xspam.ledger.v1')[0].status, 'ok');

  clickEl(doc.getElementById('xspam-undo'));      // 排上了，但慢速间隔还没到
  doc.location.pathname = '/someone/status/999';
  harness.triggerMutation();
  harness.advance(300);
  await drain();
  await settle(harness);

  const entry = storage.read('xspam.ledger.v1')[0];
  assert.equal(harness.fetches.length, 1, 'the undo never went out');
  assert.equal(entry.status, 'ok', 'a cancelled undo must not mark the original action as failed');
  assert.equal(entry.undoPending, false);
  assert.equal(entry.undoStatus, 'cancelled');
});

test('a shared nextAllowedAt from another tab delays dispatch', async () => {
  const doc = new FakeDocument('/home');
  const storage = makeStorage({ 'xspam.dispatch.v1': { nextAllowedAt: Date.now() + 9000 } });
  doc.body.appendChild(referralSpamCell(doc, 1));
  const harness = runUserscript(doc, { manualClock: true, storage });

  clickEl(actionButton(doc.body.children[0]));
  await drain();
  assert.equal(harness.fetches.length, 0, 'must wait for the slot another tab reserved');

  // 时间只走了一半：还是不许发。（「等够几次就放行」的旁路会在这里露馅。）
  harness.advance(5000);
  await drain();
  assert.equal(harness.fetches.length, 0, 'a partial wait must not be enough');

  harness.advance(5000);
  await drain();
  assert.equal(harness.fetches.length, 1, 'and it goes out once the slot actually arrives');
});

test('a throwing localStorage stops all writes instead of running without a rate limit', async () => {
  const doc = new FakeDocument('/home');
  const spam = referralSpamCell(doc, 1);
  doc.body.appendChild(spam);
  const harness = runUserscript(doc, { storage: makeStorage({}, { throws: true }) });

  assert.equal(isMarked(spam), true, 'marking still works without storage');
  clickEl(actionButton(spam));
  await drain();

  assert.equal(harness.fetches.length, 0, 'no attempt ledger means no rate limit means no writes');
  assert.match(doc.querySelector('.xspam-notice').textContent, /本地存储不可用/);
});

test('a SPA pushState cancels unsent entries through the history hook', async () => {
  const doc = new FakeDocument('/vahnxu/status/111');
  for (let i = 0; i < 3; i++) doc.body.appendChild(referralSpamCell(doc, i));
  const storage0 = makeStorage({});
  const harness = runUserscript(doc, { manualClock: true, storage: storage0 });

  clickEl(doc.getElementById('xspam-block-marked'));
  await drain();
  assert.equal(harness.fetches.length, 1);

  harness.pushState('/someone/status/999');       // 不经过 MutationObserver 去抖
  // 钩子是同步的：pushState 一返回，未发出的条目就该已经定性。
  const atNav = storage0.read('xspam.ledger.v1');
  assert.equal(atNav[1].status, 'fail');
  assert.match(atNav[1].note, /^路由切换/);

  await settle(harness);
  assert.equal(harness.fetches.length, 1, 'pushState alone must cancel the rest');
});

test('a pathname change we never observed is still caught right before dispatch', async () => {
  const doc = new FakeDocument('/vahnxu/status/111');
  for (let i = 0; i < 3; i++) doc.body.appendChild(referralSpamCell(doc, i));
  const harness = runUserscript(doc, { manualClock: true, storage: makeStorage({}) });

  clickEl(doc.getElementById('xspam-block-marked'));
  await drain();
  assert.equal(harness.fetches.length, 1);

  // X 换了 URL，但既没触发我们挂的钩子、也没等到去抖窗口跑完。
  // 队列里剩下的条目是给**上一页**排的，不能就这么发出去。
  doc.location.pathname = '/someone/status/999';
  await settle(harness);

  assert.equal(harness.fetches.length, 1, 'stale entries must be re-checked at dispatch');
});

test('a card that drops below threshold loses its badge, button and flagged membership', () => {
  const doc = new FakeDocument('/home');
  const spam = referralSpamCell(doc, 1);
  doc.body.appendChild(spam);
  const harness = runUserscript(doc);
  assert.equal(isMarked(spam), true);
  assert.ok(actionButton(spam));

  // X 把这张卡片的正文换掉了（DOM 复用 / 编辑 / 懒加载补全）
  spam.querySelector('[data-testid="tweetText"]').textContent = '早上好，今天出太阳了';
  harness.triggerMutation();

  assert.equal(isMarked(spam), false);
  assert.equal(actionButton(spam), null, 'the action button must not survive on a cleared card');
  assert.match(doc.getElementById('xspam-block-marked').textContent, /疑似\(0\)/);
});

test('a corrupted ledger is sanitised at load instead of blowing up undo', async () => {
  const doc = new FakeDocument('/home');
  // 合法条目在前，垃圾条目在后 —— 撤销取的是**最后**一条 ok，
  // 所以校验一旦失灵，就会去撤那条 action='nuke' 的假条目并当场炸掉。
  const seeded = [
    { id: 'L1', handle: 'realtarget', action: 'mute', status: 'ok', at: 'x' },
    null,
    'not an object',
    { id: 'L2', handle: 'bad', action: 'nuke', status: 'ok' },
    { id: 'L3', handle: 'bad2', action: 'mute', status: 'not-a-status' },
    { handle: 'bad3', action: 'mute', status: 'ok' },
  ];
  const storage = makeStorage({ 'xspam.ledger.v1': seeded });
  const harness = runUserscript(doc, { storage });

  clickEl(doc.getElementById('xspam-undo'));
  await drain();

  assert.equal(harness.fetches.length, 1);
  assert.match(harness.fetches[0].url, /mutes\/users\/destroy\.json$/);
  assert.match(String(harness.fetches[0].init.body), /screen_name=realtarget/);
});

test('an oversized ledger is trimmed at load and the panel says so', async () => {
  const seeded = [];
  for (let i = 0; i < 2005; i++) {
    seeded.push({ id: 'L' + i, handle: 'h' + i, action: 'mute', status: 'ok', at: 'x' });
  }
  const storage = makeStorage({ 'xspam.ledger.v1': seeded });
  const doc = new FakeDocument('/home');
  runUserscript(doc, { storage });

  assert.match(doc.querySelector('.xspam-notice').textContent, /更早的记录已不可撤销/);

  // 撤销会写回账本 —— 借这一次写回，验证**真的**只剩 2000 条，而不是只弹了个提示。
  clickEl(doc.getElementById('xspam-undo'));
  await drain();
  assert.equal(storage.read('xspam.ledger.v1').length, 2000);
});

// ===== 复审第二轮：超时 / 跨标签页账本 / 存储写失败 / 异常链路 =====

test('a request that never returns is aborted, settled as unknown and stops the queue', async () => {
  const doc = new FakeDocument('/home');
  for (let i = 0; i < 3; i++) doc.body.appendChild(referralSpamCell(doc, i));
  const storage = makeStorage({});
  const harness = runUserscript(doc, { manualClock: true, storage, fetchResponses: [{ hang: true }] });

  clickEl(doc.getElementById('xspam-block-marked'));
  await drain();
  assert.equal(harness.fetches.length, 1);

  harness.advance(19000);                 // 还没到 20 秒
  await drain();
  assert.equal(storage.read('xspam.ledger.v1')[0].status, 'intent', 'must not give up early');

  harness.advance(2000);                  // 越过超时线
  await drain();
  const entries = storage.read('xspam.ledger.v1');
  assert.equal(entries[0].status, 'unknown', 'a timeout is not a failure — it may have taken effect');
  assert.match(entries[0].note, /请求超时/);
  assert.match(doc.querySelector('.xspam-notice').textContent, /请求超时/);

  await settle(harness);
  assert.equal(harness.fetches.length, 1, 'the shared queue must not carry on after a timeout');
});

test('an exception in the dispatch chain settles the ledger and stops the queue', async () => {
  const doc = new FakeDocument('/home');
  for (let i = 0; i < 3; i++) doc.body.appendChild(referralSpamCell(doc, i));
  const storage = makeStorage({});
  const harness = runUserscript(doc, { manualClock: true, storage, fetchResponses: [{ explode: true }] });

  clickEl(doc.getElementById('xspam-block-marked'));
  await drain();
  await settle(harness);

  const entries = storage.read('xspam.ledger.v1');
  assert.equal(entries[0].status, 'unknown', 'an entry must never be left stuck at intent');
  assert.match(entries[0].note, /请求异常/);
  assert.match(doc.querySelector('.xspam-notice').textContent, /请求异常/);
  assert.equal(harness.fetches.length, 1, 'no auto-resume after an exception');
});

test('persisting the ledger merges entries another tab wrote', async () => {
  const doc = new FakeDocument('/home');
  const storage = makeStorage({});
  const spam = referralSpamCell(doc, 1);
  doc.body.appendChild(spam);
  const harness = runUserscript(doc, { manualClock: true, storage });

  // 另一个标签页在这期间记了一条真实发生过的动作
  storage.map.set('xspam.ledger.v1', JSON.stringify([
    { id: 'OTHERTAB1', handle: 'othertab', action: 'block', status: 'ok', at: 'x' },
  ]));

  clickEl(actionButton(spam));
  await drain();
  await settle(harness);

  const ids = storage.read('xspam.ledger.v1').map((e) => e.id);
  assert.ok(ids.indexOf('OTHERTAB1') >= 0, "another tab's entry must survive our write");
  assert.equal(ids.length, 2);
  assert.equal(harness.fetches.length, 1);
});

test('a failed dispatch-stamp write stops the send instead of running unpaced', async () => {
  const doc = new FakeDocument('/home');
  for (let i = 0; i < 2; i++) doc.body.appendChild(referralSpamCell(doc, i));
  // 计数写得进去，但节流时刻写不进去 —— 那下一条就无从知道该等多久。
  const storage = makeStorage({}, { throwOnSet: ['xspam.dispatch.v1'] });
  const harness = runUserscript(doc, { storage });

  clickEl(doc.getElementById('xspam-block-marked'));
  await drain();

  assert.equal(harness.fetches.length, 0, 'no pacing stamp means no send');
  assert.match(doc.querySelector('.xspam-notice').textContent, /本地存储不可用/);
});

test('an undo that cannot run for lack of login keeps the original ok entry', async () => {
  const doc = new FakeDocument('/home');
  const storage = makeStorage({});
  const spam = referralSpamCell(doc, 1);
  doc.body.appendChild(spam);
  const harness = runUserscript(doc, { manualClock: true, storage });

  clickEl(actionButton(spam));
  await drain();
  assert.equal(storage.read('xspam.ledger.v1')[0].status, 'ok');

  doc.cookie = '';                         // 登录态在这期间没了
  clickEl(doc.getElementById('xspam-undo'));
  await settle(harness);

  const entry = storage.read('xspam.ledger.v1')[0];
  assert.equal(harness.fetches.length, 1, 'the undo never went out');
  assert.equal(entry.status, 'ok', 'the original action really did succeed — keep it undoable');
  assert.equal(entry.undoStatus, 'fail');
  assert.match(entry.undoNote, /未登录/);
});

test('a recycled DOM node never keeps another account\'s done tag', async () => {
  const doc = new FakeDocument('/home');
  const spam = referralSpamCell(doc, 1);
  doc.body.appendChild(spam);
  const harness = runUserscript(doc);

  clickEl(actionButton(spam));
  await drain();
  assert.ok(spam.querySelector('.xspam-blocked-tag'), 'the card shows a done tag');
  assert.equal(spam.style.opacity, '0.35');

  // X 把这个 DOM 节点回收给了另一个（正常的）账号
  const nameBlock = spam.querySelector('[data-testid="User-Name"]');
  nameBlock.textContent = 'Nice Person @niceperson';
  spam.querySelector('[data-testid="tweetText"]').textContent = '早上好，今天出太阳了';
  harness.triggerMutation();

  assert.equal(spam.querySelector('.xspam-blocked-tag'), null, 'a stale done tag would name the wrong account');
  assert.equal(spam.style.opacity, '');
  assert.equal(isMarked(spam), false);
});

// ===== 复审第三轮：账本合并的两个坑 / 身份核对 / 共享节流不可被耐心绕过 =====

const LEDGER_KEY = 'xspam.ledger.v1';
const DISPATCH_KEY = 'xspam.dispatch.v1';
const pad4 = (n) => String(n).padStart(4, '0');

test('a stale cached entry never reverts what another tab already advanced', async () => {
  const doc = new FakeDocument('/home');
  const storage = makeStorage({});
  const a = referralSpamCell(doc, 1);
  const b = referralSpamCell(doc, 2);
  doc.body.appendChild(a);
  doc.body.appendChild(b);
  // 第一条请求一直不回来 => 本标签页手里这份永远停在 intent
  const harness = runUserscript(doc, { manualClock: true, storage, fetchResponses: [{ hang: true }] });

  clickEl(actionButton(a));
  await drain();
  const stuck = storage.read(LEDGER_KEY)[0];
  assert.equal(stuck.status, 'intent');

  // 另一个标签页把同一条推进到了 ok（服务端是真的执行了）
  const disk = storage.read(LEDGER_KEY);
  disk[0] = Object.assign({}, disk[0], { status: 'ok' });
  storage.map.set(LEDGER_KEY, JSON.stringify(disk));

  // 本标签页因为别的事又落了一次盘
  clickEl(actionButton(b));
  await drain();

  const after = storage.read(LEDGER_KEY).find((e) => e.id === stuck.id);
  assert.equal(after.status, 'ok', 'our stale copy must not drag a finished action back to intent');
  assert.equal(harness.fetches.length, 1);
});

test('a metadata-only patch never writes back a status another tab already advanced', async () => {
  const doc = new FakeDocument('/home');
  const storage = makeStorage({});
  const spam = referralSpamCell(doc, 1);
  doc.body.appendChild(spam);
  const harness = runUserscript(doc, { manualClock: true, storage });

  clickEl(actionButton(spam));
  await drain();
  const id = storage.read(LEDGER_KEY)[0].id;
  assert.equal(storage.read(LEDGER_KEY)[0].status, 'ok');

  // 本标签页排了一条撤销，但慢速间隔还没到，所以它还没发出去。
  clickEl(doc.getElementById('xspam-undo'));

  // 与此同时，另一个标签页把这条撤销真的做掉了。
  // 本标签页内存里那份还停在 status:'ok'。
  const disk = storage.read(LEDGER_KEY);
  disk[0] = Object.assign({}, disk[0], { status: 'undone', undoStatus: 'ok' });
  storage.map.set(LEDGER_KEY, JSON.stringify(disk));

  // 路由一换，本标签页取消那条没发出的撤销 —— 只动 undo 元数据，不该碰 status。
  doc.location.pathname = '/someone/status/999';
  harness.triggerMutation();
  harness.advance(300);
  await drain();
  await settle(harness);

  const after = storage.read(LEDGER_KEY).find((e) => e.id === id);
  assert.equal(after.status, 'undone', 'a stale cached status must not resurrect an undone record');
  assert.equal(after.undoStatus, 'cancelled', 'while the metadata we did change still lands');
  assert.equal(harness.fetches.length, 1, 'and the cancelled undo never went out');
});

test('a pending undo survives an intervening ledger write and is not queued twice', async () => {
  const doc = new FakeDocument('/home');
  const storage = makeStorage({});
  const a = referralSpamCell(doc, 1);
  const b = referralSpamCell(doc, 2);
  doc.body.appendChild(a);
  doc.body.appendChild(b);
  const harness = runUserscript(doc, { manualClock: true, storage });

  clickEl(actionButton(a));
  await drain();
  assert.equal(storage.read(LEDGER_KEY)[0].status, 'ok');

  clickEl(doc.getElementById('xspam-undo'));       // 排上，但还没发出
  clickEl(actionButton(b));                        // 中间插一次落盘（会重建账本对象）
  await drain();
  clickEl(doc.getElementById('xspam-undo'));       // 再点一次

  await settle(harness);

  const destroys = harness.fetches.filter((f) => /destroy\.json$/.test(f.url));
  assert.equal(destroys.length, 1, 'the same action must not be undone twice');
});

test('undo picks the target from the merged ledger, not from a stale cache', async () => {
  const doc = new FakeDocument('/home');
  const storage = makeStorage({});
  const alice = referralSpamCell(doc, 1);   // spam_referral_1
  doc.body.appendChild(alice);
  const harness = runUserscript(doc, { manualClock: true, storage });

  clickEl(actionButton(alice));
  await settle(harness);
  // 本标签页的缓存现在只有一条：Alice = ok，它就是这份快照里"最近的一条成功记录"。

  // 另一个标签页干了两件事：把 Alice 撤掉，又记了一条更新的 Bob。
  // 这两件事本标签页都不知道。
  const disk = storage.read(LEDGER_KEY);
  disk[0].status = 'undone';
  disk.push({
    id: 'BOBENTRY', handle: 'spam_referral_2', action: 'mute', status: 'ok',
    at: new Date(Date.now() + 60000).toISOString(), userId: null, score: 5, reasons: ['短评@引流'], page: 'home',
  });
  storage.map.set(LEDGER_KEY, JSON.stringify(disk));

  clickEl(doc.getElementById('xspam-undo'));
  await settle(harness);

  const destroys = harness.fetches.filter((f) => /destroy\.json$/.test(f.url));
  assert.equal(destroys.length, 1);
  const body = String(destroys[0].init.body);
  assert.match(body, /screen_name=spam_referral_2/, 'must undo the genuinely latest success');
  assert.doesNotMatch(body, /spam_referral_1/, 'must never re-undo what another tab already undid');
});

test('an undo another tab already cancelled is skipped at dispatch', async () => {
  const doc = new FakeDocument('/home');
  const storage = makeStorage({});
  const spam = referralSpamCell(doc, 1);
  doc.body.appendChild(spam);
  const harness = runUserscript(doc, { manualClock: true, storage });

  clickEl(actionButton(spam));
  await drain();
  const id = storage.read(LEDGER_KEY)[0].id;

  clickEl(doc.getElementById('xspam-undo'));      // 排上，还没发出
  assert.equal(storage.read(LEDGER_KEY)[0].undoPending, true);

  // 另一个标签页把这条待撤销取消了（记录本身仍然是 ok）
  const disk = storage.read(LEDGER_KEY);
  disk[0].undoPending = false;
  storage.map.set(LEDGER_KEY, JSON.stringify(disk));

  await settle(harness);

  const destroys = harness.fetches.filter((f) => /destroy\.json$/.test(f.url));
  assert.equal(destroys.length, 0, 'another tab called it off — do not send it anyway');
  const after = storage.read(LEDGER_KEY).find((e) => e.id === id);
  assert.equal(after.status, 'ok', 'and the original action stays undoable');
  assert.equal(after.undoStatus, 'skipped');
});

test('an undo whose record flips to undone before dispatch is skipped, not sent', async () => {
  const doc = new FakeDocument('/home');
  const storage = makeStorage({});
  const spam = referralSpamCell(doc, 1);
  doc.body.appendChild(spam);
  const harness = runUserscript(doc, { manualClock: true, storage });

  clickEl(actionButton(spam));
  await drain();
  const id = storage.read(LEDGER_KEY)[0].id;

  clickEl(doc.getElementById('xspam-undo'));      // 排上，慢速间隔未到，还没发出

  // 另一个标签页抢先把它撤掉了
  const disk = storage.read(LEDGER_KEY);
  disk[0].status = 'undone';
  storage.map.set(LEDGER_KEY, JSON.stringify(disk));

  await settle(harness);

  const destroys = harness.fetches.filter((f) => /destroy\.json$/.test(f.url));
  assert.equal(destroys.length, 0, 'nothing left to undo — do not send');
  const after = storage.read(LEDGER_KEY).find((e) => e.id === id);
  assert.equal(after.status, 'undone');
  assert.equal(after.undoStatus, 'skipped');
  assert.equal(after.undoPending, false);
});

test('merging trims the oldest entries, not whatever sat first in the array', async () => {
  const oldBase = Date.parse('2026-01-01T00:00:00.000Z');
  const seededOld = [];
  for (let i = 0; i < 2000; i++) {
    seededOld.push({
      id: 'O' + pad4(i), handle: 'o' + i, action: 'mute', status: 'ok',
      at: new Date(oldBase + i * 60000).toISOString(),
    });
  }
  const storage = makeStorage({ 'xspam.ledger.v1': seededOld });
  const doc = new FakeDocument('/home');
  const spam = referralSpamCell(doc, 1);
  doc.body.appendChild(spam);
  // 启动时把 2000 条**旧**记录读进内存
  const harness = runUserscript(doc, { manualClock: true, storage });

  // 另一个标签页把磁盘整个换成 2000 条更新的；故意把其中最旧的那条挪到数组末尾，
  // 这样「按数组顺序截断」和「按时间截断」会给出不同答案。
  const newBase = Date.parse('2026-06-01T00:00:00.000Z');
  const fresh = [];
  for (let i = 0; i < 2000; i++) {
    fresh.push({
      id: 'N' + pad4(i), handle: 'n' + i, action: 'mute', status: 'ok',
      at: new Date(newBase + i * 60000).toISOString(),
    });
  }
  storage.map.set(LEDGER_KEY, JSON.stringify(fresh.slice(1).concat([fresh[0]])));

  clickEl(actionButton(spam));            // 追加一条最新的 => 2001 条，必须砍掉一条
  await drain();

  const after = storage.read(LEDGER_KEY);
  const ids = new Set(after.map((e) => e.id));
  assert.equal(after.length, 2000);
  assert.equal(after.filter((e) => e.id.charAt(0) === 'O').length, 0, 'stale cached entries must not resurrect');
  assert.ok(!ids.has('N' + pad4(0)), 'the genuinely oldest entry is the one to drop');
  assert.ok(ids.has('N' + pad4(1)), 'a newer entry must not be dropped for being first in the array');
});

test('a card that only ever showed a done tag is still reconciled when recycled', async () => {
  const doc = new FakeDocument('/home');
  const a = referralSpamCell(doc, 1);
  doc.body.appendChild(a);
  const harness = runUserscript(doc);

  clickEl(actionButton(a));
  await drain();

  // 同一个号的第二张卡片：它直接走「已处理」那条路，压根不经过标红逻辑
  const b = referralSpamCell(doc, 1);
  doc.body.appendChild(b);
  harness.triggerMutation();
  assert.ok(b.querySelector('.xspam-blocked-tag'), 'second card shows the done tag');
  assert.equal(b.dataset.xspam, undefined, 'and it never went through the spam-marking path');

  // 这张 DOM 被 X 回收给了**另一个垃圾号**。
  // 故意选一个同样超阈值的账号：这样「掉到阈值以下就清理」那条路不会被触发，
  // 唯一能救场的就是身份核对本身。
  b.querySelector('[data-testid="User-Name"]').textContent = '短评引流九 @spam_referral_9';
  b.querySelector('[data-testid="tweetText"]').textContent = '她太涩了v 我真顶不住 @kikicez 9j';
  harness.triggerMutation();

  assert.equal(b.querySelector('.xspam-blocked-tag'), null, 'a done tag naming the previous account must not survive');
  assert.equal(b.style.opacity, '', 'nor the greyed-out styling that went with it');
  assert.equal(isMarked(b), true, 'the new occupant is judged on its own merits');
  assert.ok(actionButton(b), 'and gets its own actionable button');
});

test('a corrupt far-future stamp is ignored instead of locking the queue forever', async () => {
  const doc = new FakeDocument('/home');
  // 没有任何合法预留会指向一小时以后 —— 时钟漂移或脏数据而已，不能让它把队列钉死。
  const storage = makeStorage({ 'xspam.dispatch.v1': { nextAllowedAt: Date.now() + 3600000 } });
  const spam = referralSpamCell(doc, 1);
  doc.body.appendChild(spam);
  const harness = runUserscript(doc, { manualClock: true, storage });

  clickEl(actionButton(spam));
  await drain();

  assert.equal(harness.fetches.length, 1, 'a nonsensical stamp must not strand the queue');
});

test('a neighbour tab that keeps pushing the shared stamp keeps us waiting', async () => {
  const doc = new FakeDocument('/home');
  const storage = makeStorage({});
  const spam = referralSpamCell(doc, 1);
  doc.body.appendChild(spam);
  const harness = runUserscript(doc, { manualClock: true, storage });

  storage.map.set(DISPATCH_KEY, JSON.stringify({ nextAllowedAt: harness.now() + 5000 }));
  clickEl(actionButton(spam));
  await drain();
  assert.equal(harness.fetches.length, 0);

  // 邻居标签页每次在我们快醒来的时候又把时刻往后推。
  // 「等够几次就放行」的旁路会在第 4 次醒来时发车 —— 这里必须一次都不发。
  for (let round = 1; round <= 4; round++) {
    storage.map.set(DISPATCH_KEY, JSON.stringify({ nextAllowedAt: harness.now() + 10000 }));
    harness.advance(6000);
    await drain();
    assert.equal(harness.fetches.length, 0, 'wake-up ' + round + ' must not become a free pass');
  }

  storage.map.set(DISPATCH_KEY, JSON.stringify({ nextAllowedAt: harness.now() - 1 }));
  await settle(harness);
  assert.equal(harness.fetches.length, 1, 'and it goes out once the neighbour finally lets go');
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log('PASS', name);
    } catch (error) {
      failed++;
      console.error('FAIL', name);
      console.error(error.stack || error.message || error);
    }
  }
  if (failed) {
    console.error(`\n${failed}/${tests.length} tests failed`);
    process.exit(1);
  }
  console.log(`\n${tests.length}/${tests.length} tests passed`);
})();
