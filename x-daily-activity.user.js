// ==UserScript==
// @name         X 今日发帖 / 回复统计
// @namespace    https://github.com/Abelliuxl/x-daily-activity
// @version      0.1.1
// @description  在 X 页面右上角显示今日主动发帖数和回复数，支持拖动和自动同步。
// @author       Abelliuxl
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @updateURL    https://raw.githubusercontent.com/Abelliuxl/x-daily-activity/main/x-daily-activity.user.js
// @downloadURL  https://raw.githubusercontent.com/Abelliuxl/x-daily-activity/main/x-daily-activity.user.js
// @supportURL   https://github.com/Abelliuxl/x-daily-activity/issues
// @homepageURL  https://github.com/Abelliuxl/x-daily-activity
// ==/UserScript==

(() => {
  'use strict';

  const APP_KEY = 'x-daily-activity-state-v1';
  const CHANNEL_NAME = 'x-daily-activity-v1';
  const MAX_SYNC_PAGES = 10;
  const AUTO_SYNC_INTERVAL = 10 * 60 * 1000;
  const PAGE = typeof unsafeWindow === 'object' ? unsafeWindow : window;
  const nativeFetch = PAGE.fetch.bind(PAGE);
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL_NAME) : null;

  let state = loadState();
  let currentUserId = readUserIdFromCookie() || state.userId || null;
  let ui = null;
  let syncPromise = null;
  let lastSyncStartedAt = 0;
  let bundleCache = null;
  let observedGraphQLBase = null;

  function emptyState() {
    return { version: 1, userId: null, days: {}, lastSyncAt: 0 };
  }

  function loadState() {
    try {
      const value = GM_getValue(APP_KEY, emptyState());
      return value && value.version === 1 ? value : emptyState();
    } catch (error) {
      console.warn('[X Daily Activity] 读取本地数据失败', error);
      return emptyState();
    }
  }

  function saveState() {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const oldestKey = dateKey(cutoff);
    for (const key of Object.keys(state.days)) {
      if (key < oldestKey) delete state.days[key];
    }
    state.userId = currentUserId || state.userId;
    GM_setValue(APP_KEY, state);
    channel?.postMessage({ type: 'state-changed' });
  }

  function dateKey(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function startOfToday() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  }

  function readCookie(name) {
    const prefix = `${name}=`;
    const part = document.cookie.split(';').map((item) => item.trim()).find((item) => item.startsWith(prefix));
    if (!part) return '';
    try {
      return decodeURIComponent(part.slice(prefix.length).replace(/^"|"$/g, ''));
    } catch {
      return part.slice(prefix.length).replace(/^"|"$/g, '');
    }
  }

  function readUserIdFromCookie() {
    const match = readCookie('twid').match(/(?:^|u=)(\d+)/);
    return match?.[1] || null;
  }

  function ensureDay(key) {
    state.days[key] ||= { items: {} };
    state.days[key].items ||= {};
    return state.days[key];
  }

  function normalizeTweet(candidate) {
    let value = candidate;
    if (value?.__typename === 'TweetWithVisibilityResults') value = value.tweet;
    if (value?.tweet?.legacy && !value.legacy) value = value.tweet;
    const legacy = value?.legacy;
    if (!value?.rest_id || !legacy?.created_at) return null;

    const authorId = legacy.user_id_str || value?.core?.user_results?.result?.rest_id || null;
    const createdAt = Date.parse(legacy.created_at);
    if (!authorId || !Number.isFinite(createdAt)) return null;

    const isRetweet = Boolean(legacy.retweeted_status_result) || /^RT\s+@/i.test(legacy.full_text || '');
    const isReply = Boolean(legacy.in_reply_to_status_id_str || legacy.in_reply_to_user_id_str);
    return {
      id: String(value.rest_id),
      authorId: String(authorId),
      createdAt,
      kind: isRetweet ? 'retweet' : isReply ? 'reply' : 'post'
    };
  }

  function collectTweets(root) {
    const found = new Map();
    const seen = new WeakSet();
    const visit = (value) => {
      if (!value || typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      const tweet = normalizeTweet(value);
      if (tweet) found.set(tweet.id, tweet);
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
      } else {
        for (const item of Object.values(value)) visit(item);
      }
    };
    visit(root);
    return [...found.values()];
  }

  function ingestData(data, expectedUserId = currentUserId) {
    const tweets = collectTweets(data);
    let changed = false;
    for (const tweet of tweets) {
      if (!expectedUserId || tweet.authorId !== String(expectedUserId) || tweet.kind === 'retweet') continue;
      const key = dateKey(tweet.createdAt);
      const day = ensureDay(key);
      const next = { kind: tweet.kind, createdAt: tweet.createdAt };
      if (JSON.stringify(day.items[tweet.id]) !== JSON.stringify(next)) {
        day.items[tweet.id] = next;
        changed = true;
      }
    }
    if (changed) {
      saveState();
      render();
    }
    return tweets;
  }

  function removeTweet(tweetId) {
    let changed = false;
    for (const day of Object.values(state.days)) {
      if (day.items?.[tweetId]) {
        delete day.items[tweetId];
        changed = true;
      }
    }
    if (changed) {
      saveState();
      render();
    }
  }

  function requestDetails(input, init = {}) {
    const url = typeof input === 'string' ? input : input?.url || '';
    let body = init.body;
    if (body == null && typeof input === 'object') body = input.body;
    return { url, body };
  }

  function deletedTweetId(url, body) {
    if (!/\/DeleteTweet(?:\?|$)/.test(url)) return null;
    try {
      if (typeof body === 'string') {
        const parsed = JSON.parse(body);
        return String(parsed?.variables?.tweet_id || parsed?.variables?.tweetId || '') || null;
      }
      const variables = new URL(url, location.href).searchParams.get('variables');
      const parsed = variables ? JSON.parse(variables) : null;
      return String(parsed?.tweet_id || parsed?.tweetId || '') || null;
    } catch {
      return null;
    }
  }

  function shouldInspect(url) {
    return /\/(?:graphql|i\/api)\//.test(url) || /Tweet|Timeline|Viewer/.test(url);
  }

  function rememberGraphQLBase(url) {
    try {
      const parsed = new URL(url, location.href);
      const match = parsed.pathname.match(/^(.*\/graphql)\/[^/]+\/[^/?]+/);
      if (match) observedGraphQLBase = `${parsed.origin}${match[1]}`;
    } catch {}
  }

  function installNetworkObserver() {
    PAGE.fetch = async function observedFetch(input, init) {
      const details = requestDetails(input, init);
      rememberGraphQLBase(details.url);
      const response = await nativeFetch(input, init);
      if (response.ok && shouldInspect(details.url)) {
        const deletedId = deletedTweetId(details.url, details.body);
        if (deletedId) removeTweet(deletedId);
        response.clone().json().then((data) => ingestData(data)).catch(() => {});
      }
      return response;
    };

    const NativeXHR = PAGE.XMLHttpRequest;
    if (!NativeXHR?.prototype) return;
    const nativeOpen = NativeXHR.prototype.open;
    const nativeSend = NativeXHR.prototype.send;
    NativeXHR.prototype.open = function observedOpen(method, url, ...rest) {
      this.__xdaUrl = String(url || '');
      rememberGraphQLBase(this.__xdaUrl);
      return nativeOpen.call(this, method, url, ...rest);
    };
    NativeXHR.prototype.send = function observedSend(body) {
      const url = this.__xdaUrl || '';
      if (shouldInspect(url)) {
        this.addEventListener('load', () => {
          if (this.status < 200 || this.status >= 300) return;
          const deletedId = deletedTweetId(url, body);
          if (deletedId) removeTweet(deletedId);
          try {
            const data = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
            ingestData(data);
          } catch {}
        }, { once: true });
      }
      return nativeSend.call(this, body);
    };
  }

  function findMainBundleUrl() {
    const script = [...document.scripts].map((item) => item.src).find((src) => /\/main\.[\w-]+\.js(?:\?|$)/.test(src));
    if (script) return script;
    const resource = performance.getEntriesByType('resource').map((item) => item.name)
      .find((src) => /\/main\.[\w-]+\.js(?:\?|$)/.test(src));
    return resource || null;
  }

  async function loadMainBundle() {
    if (bundleCache) return bundleCache;
    let url = findMainBundleUrl();
    if (!url) {
      const html = await nativeFetch(location.origin, { credentials: 'include' }).then((response) => response.text());
      const match = html.match(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/main\.[\w-]+\.js/);
      url = match?.[0] || null;
    }
    if (!url) throw new Error('未找到 X 主程序资源');
    const text = await nativeFetch(url, { credentials: 'omit' }).then((response) => {
      if (!response.ok) throw new Error(`读取 X 主程序失败 (${response.status})`);
      return response.text();
    });
    bundleCache = { text, url };
    return bundleCache;
  }

  function discoverOperation(bundleText, operationName) {
    const marker = `operationName:"${operationName}"`;
    const markerIndex = bundleText.indexOf(marker);
    if (markerIndex < 0) throw new Error(`X 当前版本未包含 ${operationName}`);
    const start = Math.max(0, markerIndex - 150);
    const snippet = bundleText.slice(start, markerIndex + 6000);
    const queryId = snippet.match(/queryId:"([^"]+)"/)?.[1];
    const featureText = snippet.match(/featureSwitches:\[([^\]]*)\]/)?.[1] || '';
    const fieldText = snippet.match(/fieldToggles:\[([^\]]*)\]/)?.[1] || '';
    const quotedValues = (text) => [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    if (!queryId) throw new Error(`无法解析 ${operationName} 的 queryId`);
    return { operationName, queryId, features: quotedValues(featureText), fields: quotedValues(fieldText) };
  }

  function discoverBearer(bundleText) {
    const token = bundleText.match(/Bearer\s+(AAAAA[A-Za-z0-9%_-]{50,})/)?.[1];
    if (!token) throw new Error('无法解析 X Web 授权信息');
    return decodeURIComponent(token);
  }

  const TRUE_FEATURES = new Set([
    'responsive_web_graphql_timeline_navigation_enabled',
    'responsive_web_edit_tweet_api_enabled',
    'graphql_is_translatable_rweb_tweet_is_translatable_enabled',
    'view_counts_everywhere_api_enabled',
    'longform_notetweets_consumption_enabled',
    'responsive_web_twitter_article_tweet_consumption_enabled',
    'freedom_of_speech_not_reach_fetch_enabled',
    'standardized_nudges_misinfo',
    'tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled',
    'longform_notetweets_rich_text_read_enabled',
    'longform_notetweets_inline_media_enabled'
  ]);

  async function graphQL(operation, variables, bundleText) {
    const csrf = readCookie('ct0');
    if (!csrf) throw new Error('未检测到 X 登录会话');
    const features = Object.fromEntries(operation.features.map((name) => [name, TRUE_FEATURES.has(name)]));
    const fieldToggles = Object.fromEntries(operation.fields.map((name) => [name, false]));
    const params = new URLSearchParams({
      variables: JSON.stringify(variables),
      features: JSON.stringify(features),
      fieldToggles: JSON.stringify(fieldToggles)
    });
    const apiOrigin = location.hostname.endsWith('twitter.com') ? 'https://api.twitter.com' : 'https://api.x.com';
    const bases = [...new Set([
      observedGraphQLBase,
      `${apiOrigin}/graphql`,
      `${location.origin}/i/api/graphql`
    ].filter(Boolean))];
    let lastError = null;

    for (let index = 0; index < bases.length; index += 1) {
      const base = bases[index];
      const url = `${base}/${operation.queryId}/${operation.operationName}?${params}`;
      let response;
      try {
        response = await nativeFetch(url, {
          credentials: 'include',
          headers: {
            authorization: `Bearer ${discoverBearer(bundleText)}`,
            'x-csrf-token': csrf,
            'x-twitter-active-user': 'yes',
            'x-twitter-auth-type': 'OAuth2Session',
            'x-twitter-client-language': document.documentElement.lang || 'zh-cn'
          }
        });
      } catch (error) {
        lastError = error;
        if (index === bases.length - 1) throw error;
        continue;
      }
      const data = await response.json().catch(() => null);
      if (response.ok && data) {
        observedGraphQLBase = base;
        return data;
      }
      const message = data?.errors?.[0]?.message || `X 请求失败 (${response.status})`;
      lastError = new Error(message);
      if (![403, 404].includes(response.status) || index === bases.length - 1) throw lastError;
    }
    throw lastError || new Error('X 请求失败');
  }

  function findViewerUserId(root) {
    const direct = root?.data?.viewer?.user_results?.result?.rest_id || root?.data?.viewer?.user?.rest_id;
    if (direct) return String(direct);
    let result = null;
    const seen = new WeakSet();
    const visit = (value, key = '') => {
      if (result || !value || typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      if (/viewer/i.test(key) && value?.rest_id && (value?.legacy?.screen_name || value?.core)) {
        result = String(value.rest_id);
        return;
      }
      for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
    };
    visit(root);
    return result;
  }

  function findBottomCursor(root) {
    let cursor = null;
    const seen = new WeakSet();
    const visit = (value) => {
      if (cursor || !value || typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      if (value.cursorType === 'Bottom' && typeof value.value === 'string') {
        cursor = value.value;
        return;
      }
      for (const child of Object.values(value)) visit(child);
    };
    visit(root);
    return cursor;
  }

  function collectChronologicalTweets(root) {
    const found = new Map();
    const seen = new WeakSet();
    const visit = (value) => {
      if (!value || typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      if (value.type === 'TimelinePinEntry') return;
      if (value.type === 'TimelineAddEntries' && Array.isArray(value.entries)) {
        for (const entry of value.entries) {
          for (const tweet of collectTweets(entry)) found.set(tweet.id, tweet);
        }
        return;
      }
      for (const child of Object.values(value)) visit(child);
    };
    visit(root);
    return [...found.values()];
  }

  async function resolveCurrentUserId(bundleText) {
    const cookieId = readUserIdFromCookie();
    if (cookieId) return cookieId;
    if (currentUserId) return currentUserId;
    const viewer = discoverOperation(bundleText, 'Viewer');
    const data = await graphQL(viewer, {}, bundleText);
    const id = findViewerUserId(data);
    if (!id) throw new Error('无法确定当前 X 用户');
    return id;
  }

  async function syncTimeline({ manual = false } = {}) {
    if (syncPromise) return syncPromise;
    if (!manual && Date.now() - lastSyncStartedAt < 30_000) return;
    lastSyncStartedAt = Date.now();
    setStatus('正在同步…', 'working');

    syncPromise = (async () => {
      const { text } = await loadMainBundle();
      currentUserId = await resolveCurrentUserId(text);
      const operation = discoverOperation(text, 'UserTweetsAndReplies');
      let cursor;
      let complete = false;
      let pages = 0;
      const cursorHistory = new Set();

      while (pages < MAX_SYNC_PAGES) {
        const variables = {
          userId: currentUserId,
          count: 40,
          includePromotedContent: false,
          withCommunity: true,
          withVoice: true,
          withQuickPromoteEligibilityTweetFields: false,
          ...(cursor ? { cursor } : {})
        };
        const data = await graphQL(operation, variables, text);
        const allTweets = ingestData(data, currentUserId);
        const chronological = collectChronologicalTweets(data);
        const relevant = (chronological.length ? chronological : allTweets)
          .filter((tweet) => tweet.authorId === currentUserId);
        pages += 1;

        if (relevant.some((tweet) => tweet.createdAt < startOfToday())) {
          complete = true;
          break;
        }
        const nextCursor = findBottomCursor(data);
        if (!nextCursor || cursorHistory.has(nextCursor)) {
          complete = true;
          break;
        }
        cursorHistory.add(nextCursor);
        cursor = nextCursor;
      }

      state.lastSyncAt = Date.now();
      saveState();
      render();
      const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
        .format(state.lastSyncAt);
      setStatus(complete ? `已同步 ${time}` : `已同步前 ${MAX_SYNC_PAGES} 页`, complete ? 'ok' : 'warning');
    })().catch((error) => {
      console.warn('[X Daily Activity] 同步失败', error);
      setStatus(error.message || '同步失败', 'error');
    }).finally(() => {
      syncPromise = null;
    });
    return syncPromise;
  }

  function todayCounts() {
    const items = Object.values(state.days[dateKey()]?.items || {});
    return {
      posts: items.filter((item) => item.kind === 'post').length,
      replies: items.filter((item) => item.kind === 'reply').length
    };
  }

  function mountUi() {
    if (ui || !document.documentElement) return;
    const host = document.createElement('div');
    host.id = 'x-daily-activity-host';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; color-scheme: light dark; }
        .card {
          position: fixed; top: 76px; right: 16px; z-index: 2147483647; width: 224px;
          box-sizing: border-box; overflow: hidden; border: 1px solid rgba(128,128,128,.28);
          border-radius: 16px; color: #e7e9ea; background: rgba(15,20,25,.94);
          box-shadow: 0 10px 32px rgba(0,0,0,.28); backdrop-filter: blur(16px);
          font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
          user-select: none; touch-action: none;
        }
        .head { display:flex; align-items:center; justify-content:space-between; padding:11px 12px 7px; cursor:grab; }
        .head:active { cursor:grabbing; }
        .title { font-size:14px; line-height:20px; font-weight:700; letter-spacing:.1px; }
        .refresh { width:28px; height:28px; padding:0; border:0; border-radius:999px; color:inherit; background:transparent; cursor:pointer; font-size:17px; line-height:28px; }
        .refresh:hover { background:rgba(29,155,240,.15); color:#1d9bf0; }
        .refresh[disabled] { opacity:.45; cursor:default; }
        .date { padding:0 12px 10px; color:#8b98a5; font-size:11px; }
        .stats { display:grid; grid-template-columns:1fr 1fr; gap:8px; padding:0 12px 12px; }
        .stat { border-radius:12px; padding:10px; background:rgba(255,255,255,.07); }
        .number { display:block; font-size:26px; line-height:30px; font-weight:800; font-variant-numeric:tabular-nums; }
        .label { display:block; margin-top:2px; color:#aab4bd; font-size:12px; }
        .status { overflow:hidden; padding:8px 12px 10px; border-top:1px solid rgba(128,128,128,.18); color:#8b98a5; font-size:11px; line-height:16px; text-overflow:ellipsis; white-space:nowrap; }
        .status[data-tone="working"] { color:#1d9bf0; }
        .status[data-tone="error"] { color:#f4212e; }
        .status[data-tone="warning"] { color:#ffd400; }
        @media (prefers-color-scheme: light) {
          .card { color:#0f1419; background:rgba(255,255,255,.95); box-shadow:0 10px 32px rgba(15,20,25,.16); }
          .stat { background:rgba(15,20,25,.06); }
          .label,.date,.status { color:#536471; }
        }
      </style>
      <section class="card" aria-label="X 今日活动统计">
        <div class="head">
          <div class="title">X 今日活动</div>
          <button class="refresh" type="button" title="立即同步" aria-label="立即同步">↻</button>
        </div>
        <div class="date"></div>
        <div class="stats">
          <div class="stat"><span class="number posts">0</span><span class="label">主动发帖</span></div>
          <div class="stat"><span class="number replies">0</span><span class="label">回复</span></div>
        </div>
        <div class="status" data-tone="working">正在准备…</div>
      </section>`;
    (document.body || document.documentElement).append(host);
    ui = {
      host,
      card: shadow.querySelector('.card'),
      head: shadow.querySelector('.head'),
      date: shadow.querySelector('.date'),
      posts: shadow.querySelector('.posts'),
      replies: shadow.querySelector('.replies'),
      status: shadow.querySelector('.status'),
      refresh: shadow.querySelector('.refresh')
    };
    ui.refresh.addEventListener('click', (event) => {
      event.stopPropagation();
      syncTimeline({ manual: true });
    });
    installDrag();
    render();
  }

  function installDrag() {
    let drag = null;
    ui.head.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button')) return;
      const rect = ui.card.getBoundingClientRect();
      drag = { id: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top };
      ui.head.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    ui.head.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const maxLeft = Math.max(8, innerWidth - ui.card.offsetWidth - 8);
      const maxTop = Math.max(8, innerHeight - ui.card.offsetHeight - 8);
      const left = Math.min(maxLeft, Math.max(8, event.clientX - drag.dx));
      const top = Math.min(maxTop, Math.max(8, event.clientY - drag.dy));
      Object.assign(ui.card.style, { left: `${left}px`, top: `${top}px`, right: 'auto' });
    });
    const end = (event) => {
      if (drag && event.pointerId === drag.id) drag = null;
    };
    ui.head.addEventListener('pointerup', end);
    ui.head.addEventListener('pointercancel', end);
  }

  function render() {
    if (!ui) return;
    const counts = todayCounts();
    ui.posts.textContent = String(counts.posts);
    ui.replies.textContent = String(counts.replies);
    ui.date.textContent = `${dateKey()} · 本机时区`;
  }

  function setStatus(message, tone = '') {
    if (!ui) return;
    ui.status.textContent = message;
    ui.status.dataset.tone = tone;
    ui.refresh.disabled = tone === 'working';
  }

  function start() {
    installNetworkObserver();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', mountUi, { once: true });
    } else {
      mountUi();
    }
    setTimeout(() => syncTimeline(), 1800);
    setInterval(() => {
      render();
      if (!document.hidden) syncTimeline();
    }, AUTO_SYNC_INTERVAL);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && Date.now() - state.lastSyncAt > AUTO_SYNC_INTERVAL) syncTimeline();
    });
    channel?.addEventListener('message', () => {
      state = loadState();
      render();
    });
    if (typeof GM_addValueChangeListener === 'function') {
      GM_addValueChangeListener(APP_KEY, (_name, _oldValue, newValue, remote) => {
        if (remote && newValue?.version === 1) {
          state = newValue;
          render();
        }
      });
    }
  }

  start();
})();
