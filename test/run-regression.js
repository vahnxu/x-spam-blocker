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
    if (selector === '#xspam-collector') return this.id === 'xspam-collector';
    if (selector === '.xspam-blocked-tag') return this.className.split(/\s+/).includes('xspam-blocked-tag');
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

function runUserscript(doc) {
  const logs = [];
  const warnings = [];
  const observers = [];
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
    setTimeout: (fn) => {
      fn();
      return 0;
    },
    clearTimeout() {},
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
    fetch: async () => ({ ok: true, status: 200 }),
  };
  context.window.setTimeout = context.setTimeout;
  context.window.clearTimeout = context.clearTimeout;
  context.window.MutationObserver = context.MutationObserver;
  context.window.Blob = context.Blob;
  context.window.URL = context.URL;
  context.window.fetch = context.fetch;

  vm.runInNewContext(USERSCRIPT_SOURCE, context, { filename: USERSCRIPT_PATH });

  return {
    logs,
    warnings,
    triggerMutation() {
      observers.forEach((callback) => callback([]));
    },
  };
}

function isMarked(cell) {
  return cell.dataset.xspam === '1';
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
