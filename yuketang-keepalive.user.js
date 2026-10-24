// ==UserScript==
// @name         雨课堂 播放保活 v3（真播·进度会涨）
// @namespace    local.ykt.keepalive
// @version      3.1
// @description  1x 真实播放；防切后台暂停；防计时器节流；播完自动连播（接口算下一节）；内置心跳诊断
// @author       local
// @match        *://*.yuketang.cn/*
// @match        *://*.gdufemooc.cn/*
// @match        *://*.xuetangx.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  /* ═══════════ 0. 基础设施（全部变量先声明，避免 TDZ） ═══════════ */

  const LOG = [];
  let panelLog = null, statusEl = null, btnEl = null, beatEl = null;
  let running = false;
  let userPauseAt = 0;
  let beatCount = 0, lastBeat = 0, lastBeatStatus = '';

  /* ── 页面参数（必须在最前面解析，后续模块都要用） ── */
  const CUR_LEAF = (() => {
    const m = location.href.match(/\/video\/(\d{5,})/) ||
      location.href.match(/\/audio\/(\d{5,})/) ||
      location.href.match(/\/lms\/(\d+)\/graph\/(\d{5,})/);
    if (!m) return null;
    return m.length > 2 ? m[2] : m[1];
  })();

  const CLASSROOM = (() => {
    const m = location.href.match(/lms-graph(?:-mobile)?\/(\d{5,})/) ||
      location.href.match(/lms\/(\d{5,})\//) ||
      location.href.match(/classroom_id=(\d{5,})/);
    return m ? m[1] : null;
  })();

  const push = (m) => {
    const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${m}`;
    LOG.push(line);
    if (LOG.length > 400) LOG.shift();
    try { console.log('[保活]', m); } catch (_) { }
    if (panelLog) {
      const d = document.createElement('div');
      d.textContent = line;
      panelLog.appendChild(d);
      panelLog.scrollTop = panelLog.scrollHeight;
      while (panelChildCount() > 300) panelLog.removeChild(panelLog.firstChild);
    }
  };
  const panelChildCount = () => (panelLog ? panelLog.childElementCount : 0);

  // 只在「页面里真的有播放器」时才拦截事件，避免影响登录页/验证码
  const hasPlayer = () => !!document.querySelector('video, audio');

  /* ═══════════ 1. 反「切后台自动暂停」 ═══════════
     站点 forcer 源码 winTriggerHidden()：
       o = {focus:'visible',focusin:'visible',pageshow:'visible',
            blur:'hidden',focusout:'hidden',pagehide:'hidden'}
       命中 hidden → $video.trigger('playBtn.toggle',{xtStateType:'pause'})
     同时 document.onfocusin = document.onfocusout = r 直接挂属性。
     对策：伪装 hidden/visibilityState + 拦截事件 + 封掉属性赋值。            */

  try {
    const def = (proto, name, val) => {
      try {
        Object.defineProperty(proto, name, { configurable: true, get: () => val });
      } catch (_) { }
    };
    def(Document.prototype, 'hidden', false);
    def(Document.prototype, 'visibilityState', 'visible');
    def(Document.prototype, 'webkitHidden', false);
    def(Document.prototype, 'webkitVisibilityState', 'visible');
  } catch (e) { push('可见性伪装异常: ' + e.message); }

  const HIDE_EVENTS = ['visibilitychange', 'webkitvisibilitychange',
    'mozvisibilitychange', 'msvisibilitychange',
    'blur', 'focusout', 'pagehide', 'freeze'];

  const swallow = (ev) => {
    if (!hasPlayer()) return;           // 无播放器时放行，不影响别的页面功能
    ev.stopImmediatePropagation();
    ev.stopPropagation();
  };
  HIDE_EVENTS.forEach((t) => window.addEventListener(t, swallow, true));

  // 封掉站点用属性方式注册的隐藏回调
  ['onblur', 'onfocusout', 'onpagehide', 'onvisibilitychange', 'onfocusin'].forEach((k) => {
    try {
      Object.defineProperty(document, k, { configurable: true, get: () => null, set: () => { } });
    } catch (_) { }
    try {
      Object.defineProperty(window, k, { configurable: true, get: () => null, set: () => { } });
    } catch (_) { }
  });

  /* ═══════════ 2. 防后台计时器节流（Worker 计时器） ═══════════
     后台标签页 setInterval 被限到 1 次/分钟，站点心跳就断了。
     Worker 里的 timer 不受页面节流影响，用它驱动主线程校验。 */

  let worker = null;
  const workerTicks = [];
  try {
    const code = `let id=null;self.onmessage=e=>{const d=e.data||{};
      if(d.cmd==='start'){if(id)clearInterval(id);id=setInterval(()=>self.postMessage(1),d.ms||1000);}
      else{if(id)clearInterval(id);id=null;}};`;
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    worker = new Worker(url);
    worker.onmessage = () => {
      workerTicks.push(Date.now());
      if (workerTicks.length > 120) workerTicks.shift();
    };
    worker.postMessage({ cmd: 'start', ms: 1000 });
  } catch (e) { push('Worker 计时器不可用: ' + e.message); }

  /* ═══════════ 3. 播放器挂钩 ═══════════ */

  // 播放器可能在 iframe 内（lms-graph / ai-workspace 常见）。
  // 本脚本在每个 frame 里都会跑，谁找到 video 谁负责；跨域 iframe 由脚本自己被注入后处理。
  const pickVideo = () => {
    const all = [...document.querySelectorAll('video')];
    if (!all.length) return null;
    return all.find((v) => !v.paused) ||
      all.slice().sort((a, b) => (b.duration || 0) - (a.duration || 0))[0] ||
      null;
  };

  let hooked = null;
  const hookedSet = new WeakSet();

  const hook = (v) => {
    if (!v) return;
    // 用 WeakSet 判重：SPA 路由切换会换掉 <video> 元素，
    // 只比较单例引用会在"同一对象被复用"时漏挂，导致 ended 不触发。
    if (hookedSet.has(v)) return;
    hookedSet.add(v);
    hooked = v;

    // 关键：站点 sendEvents 里 timeNoUpdateNum > 10 会强制暂停播放器，
    // 而 currentTime 不前进正是后台冻结的表现。这里保证「暂停即续播」。
    v.addEventListener('pause', () => {
      if (!running || v.ended) return;
      if (Date.now() - userPauseAt < 1500) return;      // 用户主动暂停，尊重
      setTimeout(() => {
        if (!running || !v.paused || v.ended) return;
        v.play().catch(() => { });
        push('检测到非主动暂停 → 已续播');
      }, 150);
    });

    // 站点会按 speed.value 上报倍速；倍速播放会被服务端折算，保持 1x。
    // 但若另有脚本（如刷课助手）硬设倍速，会和我们来回抢，这里做退让保护。
    let rateFights = [];
    let rateSurrender = false;
    let state_rate = 1;
    const lockRate = () => {
      if (rateSurrender) return;
      try {
        const cur = v.playbackRate;
        if (Math.abs(cur - 1) > 0.001) {
          const now = Date.now();
          rateFights.push(now);
          rateFights = rateFights.filter((t) => now - t < 4000);
          if (rateFights.length >= 3) {
            rateSurrender = true;
            push('检测到其他脚本在改倍速，已停止纠偏以免互相打架；请把插件倍速设为 1x');
            return;
          }
          v.playbackRate = 1;
          push('倍速被改为 ' + cur + '，已拉回 1.0（倍速不计满进度）');
        }
        state_rate = v.playbackRate;
      } catch (_) { }
    };
    v.addEventListener('ratechange', lockRate);
    lockRate();

    toastUp(v);

    v.addEventListener('play', () => push('播放中 ×' + v.playbackRate));

    // 播完检测：ended 在某些播放器/跳转场景下不触发，用 timeupdate 兜底。
    // 双保险，且用 finishFired 防止重复跳转。
    let finishFired = false;
    const onFinish = (from) => {
      if (finishFired) return;
      finishFired = true;
      push('本节播完（' + from + '）');
      if (!running) return;
      // 播完时进度还没同步到服务端：等心跳把 cp=d 上报完再走，
      // 否则下一节取进度时会把刚看完这节又算成未完成，导致回头重播。
      push('等待进度同步（约 8 秒）…');
      setTimeout(() => { finishFired = false; nextLeaf(); }, 8000);
    };

    v.addEventListener('ended', () => onFinish('ended'));
    v.addEventListener('timeupdate', () => {
      const d = v.duration || 0;
      if (d > 1 && v.currentTime >= d - 0.35 && !v.paused) onFinish('timeupdate');
    });
    // 站点把播放器暂停在末尾也算看完
    v.addEventListener('pause', () => {
      const d = v.duration || 0;
      if (d > 1 && v.currentTime >= d - 1.2) onFinish('pause-at-end');
    });

    v.addEventListener('error', () => push('播放器报错 code=' + (v.error && v.error.code)));

    push(`已挂钩播放器，时长 ${Math.round(v.duration || 0)}s`);
  };

  // 音量极低但「非静音」：Chromium 只对可听标签页豁免后台冻结
  let keepAudible = true;
  const toastUp = (v) => {
    try {
      if (!keepAudible) return;
      v.muted = false;
      if (v.volume > 0.05) v.volume = 0.02;
    } catch (_) { }
  };

  /* ═══════════ 4. 心跳诊断（只读，不改请求） ═══════════
     站点心跳：POST /video-log/heartbeat/  头 xtbz / X-CSRFToken
     载荷：{heart_data: JSON字符串(数组的JSON)}
     每项字段顺序固定，cp=当前进度(秒)，d=总时长，sp=倍速，et=事件
     服务端据此累计有效观看时长 → 完成率。心跳断 = 完成率不动。 */

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  const noteBeat = (sample) => {
    beatCount++;
    lastBeat = Date.now();
    lastBeatStatus = 'ok';
    if (beatEl) beatEl.textContent = String(beatCount);
    if (beatCount <= 3 || beatCount % 20 === 0) push(`心跳#${beatCount} OK ${sample}`);
  };

  // fetch 通道（部分页面用 fetch 发心跳）
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (...a) {
      const pr = origFetch.apply(this, a);
      try {
        const u = String(a[0] && a[0].url ? a[0].url : a[0]);
        if (u.indexOf('/video-log/heartbeat') >= 0 || u.indexOf('/video-log/log/track') >= 0) {
          pr.then((r) => {
            if (r.status >= 400) push('心跳失败 HTTP ' + r.status);
            else noteBeat('via fetch');
          }).catch(() => push('心跳网络错误(fetch)'));
        }
      } catch (_) { }
      return pr;
    };
  }

  XMLHttpRequest.prototype.open = function (m, u) {
    try { this.__yktUrl = String(u); } catch (_) { }
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    try {
      const u = String(this.__yktUrl || '');
      if (u.indexOf('/video-log/heartbeat') >= 0) {
        let sample = '';
        try {
          const outer = JSON.parse(body);
          const arr = JSON.parse(outer.heart_data);
          const last = arr[arr.length - 1] || [];
          sample = `cp=${last[11]} d=${last[12]} sp=${last[15]} et=${last[1]}`;
        } catch (_) { sample = ''; }
        this.addEventListener('load', () => {
          beatCount++;
          lastBeat = Date.now();
          lastBeatStatus = 'HTTP ' + this.status;
          if (this.status >= 400) {
            push(`心跳失败 ${this.status} ${String(this.responseText).slice(0, 90)}`);
          } else if (beatCount <= 3 || beatCount % 20 === 0) {
            push(`心跳#${beatCount} OK ${sample}`);
          }
          if (beatEl) beatEl.textContent = String(beatCount);
        });
        this.addEventListener('error', () => push('心跳网络错误'));
      }
    } catch (_) { }
    return origSend.apply(this, arguments);
  };

  /* ═══════════ 位图：记录已进入的节点，防重复触发 ═══════════ */
  const VISITED_KEY = 'ykt_ka_visited';
  const loadVisited = () => {
    try { return new Set(JSON.parse(localStorage.getItem(VISITED_KEY) || '[]')); }
    catch (_) { return new Set(); }
  };
  const saveVisited = (set) => {
    try { localStorage.setItem(VISITED_KEY, JSON.stringify([...set].slice(-300))); } catch (_) { }
  };
  const visited = loadVisited();
  if (CUR_LEAF) { visited.add(String(CUR_LEAF)); saveVisited(visited); }

  /* ═══════════ 5. 自动下一节（接口优先，DOM 兜底） ═══════════
     实测教训：新版 ai-workspace 播放页里没有 .leaf-detail 目录树，
     纯 DOM 方案在播放页必然失败（日志：「当前页没有目录」）。
     因此改为三条路依次尝试：

     ① 抓播放器配置：播放器初始化时会收到 preLeaf / nextLeaf（站点源码实证），
        这两个对象里有下一节 id，最接近站点自己的行为。
     ② 调接口算：/mooc-api/v1/lms/learn/course/chapter 返回完整目录，
        按 leaf id 定位后取下一个未完成视频，直接构造播放页 URL 跳转。
     ③ DOM 兜底：仅在目录页可用时使用。

     跳转 URL 规则（由用户实际 URL 验证）：
        {base}/ai-workspace/lms-graph/{classroom_id}/video/{leaf_id}?is_chapter=1&node_id={section_id}
     base 从当前地址推断，不写死。                                        */

  // 页面 origin 前缀（保留 /ai-workspace 这类 base）
  const pageBase = () => {
    const p = location.pathname;
    const i = p.indexOf('/ai-workspace');
    if (i >= 0) return location.origin + p.slice(0, i);
    return location.origin;
  };

  // ① 播放器配置里的 preLeaf / nextLeaf
  let leafNeighbors = null;

  const scanPlayerConfig = () => {
    if (leafNeighbors) return leafNeighbors;
    // 从 Vue 组件实例里找（站点用 Vue2，__vue__ 指向组件）
    const roots = [document.querySelector('#app'), document.body];
    const seen = new Set();
    const walk = (node, depth) => {
      if (!node || depth > 6) return null;
      if (seen.has(node)) return null;
      seen.add(node);
      const cfg = node.$options && node.$options.propsData;
      const data = node._data || cfg;
      if (data && (data.nextLeaf || data.preLeaf)) {
        return { next: data.nextLeaf, pre: data.preLeaf, list: data.courseData };
      }
      const kids = node.$children || [];
      for (const k of kids) { const r = walk(k, depth + 1); if (r) return r; }
      return null;
    };
    for (const r of roots) {
      try {
        const hit = walk(r && r.__vue__ ? r.__vue__ : null, 0);
        if (hit) { leafNeighbors = hit; return hit; }
      } catch (_) { }
    }
    return null;
  };

  // ② 接口算下一节
  const fetchChapter = async () => {
    if (!CLASSROOM) return null;
    // sign 在页面里，从已发出的请求或地址里取
    const m = location.href.match(/[?&]sign=([^&]+)/);
    const sign = m ? m[1] : '';
    const url = `/mooc-api/v1/lms/learn/course/chapter?cid=${CLASSROOM}&classroom_id=${CLASSROOM}` +
      (sign ? `&sign=${sign}` : '') + '&show_unpublished=false&query=&leaf_type=';
    try {
      const r = await fetch(url, { credentials: 'include' });
      const j = await r.json();
      return j && j.data ? j.data : null;
    } catch (e) { push('取目录失败: ' + e.message); return null; }
  };

  const flatten = (data) => {
    const out = [];
    const chapters = (data && data.course_chapter) || [];
    for (const c of chapters) {
      const secs = c.section_leaf_list || [];
      for (const s of secs) {
        const leaves = s.leaf_list || [s];
        for (const l of leaves) {
          if (!l || l.is_locked) continue;
          out.push({
            id: String(l.id),
            name: l.name || '',
            type: l.leaf_type,
            sectionId: l.section_id || s.section_id || s.id,
            chapterId: l.chapter_id || c.chapter_id || c.id,
          });
        }
      }
    }
    return out;
  };

  // 进度：接口返回 leaf_schedules（0~1）
  const fetchSchedules = async () => {
    if (!CLASSROOM) return {};
    const m = location.href.match(/[?&]sign=([^&]+)/);
    const sign = m ? m[1] : '';
    try {
      const r = await fetch(`/mooc-api/v1/lms/learn/course/schedule?cid=${CLASSROOM}` +
        (sign ? `&sign=${sign}` : '') + `&classroom_id=${CLASSROOM}`, { credentials: 'include' });
      const j = await r.json();
      return (j && j.data && j.data.leaf_schedules) || {};
    } catch (_) { return {}; }
  };

  const leafDoneById = (sched, id) => {
    const v = sched[String(id)];
    if (v === undefined || v === null) return false;
    const n = typeof v === 'object' ? (v.done / (v.total || 1)) : Number(v);
    return n >= 1;
  };

  const buildUrl = (leaf) => {
    const base = pageBase();
    const node = leaf.sectionId || 0;
    return `${base}/ai-workspace/lms-graph/${CLASSROOM}/video/${leaf.id}?is_chapter=1&node_id=${node}`;
  };

  // ③ DOM 兜底
  const LEAF_SEL = '.leaf-detail';
  const leafIsPlayable = (n) =>
    !!n.querySelector('.icon--shipin, .icon--yinpin') &&
    !n.querySelector('.icon--zhibo, .icon--tuwen');
  const leafDoneDom = (n) => {
    const t = (n.textContent || '');
    if (/已完成/.test(t)) return true;
    const m = t.match(/(\d{1,3})\s*%/);
    return m ? Number(m[1]) >= 100 : false;
  };
  const collectDom = () => [...document.querySelectorAll(LEAF_SEL)]
    .filter(leafIsPlayable)
    .map((n) => ({ n, done: leafDoneDom(n), title: (n.querySelector('.title')?.textContent || '').trim() }));

  const humanClick = (node) => {
    const r = node.getBoundingClientRect();
    const x = r.left + Math.min(r.width / 2, 30);
    const y = r.top + r.height / 2;
    const fire = (t, cx, cy) => node.dispatchEvent(new MouseEvent(t, {
      bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy,
    }));
    node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, view: window, clientX: x, clientY: y }));
    fire('mousemove', x, y);
    fire('mousemove', x + 2, y + 2);
    node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, view: window, clientX: x, clientY: y }));
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, view: window, clientX: x, clientY: y }));
    fire('click', x, y);
  };

  let advancing = false;

  const nextLeaf = async () => {
    if (advancing) return;
    advancing = true;
    try {
      // ① 播放器组件里的 nextLeaf（站点自己算的，最接近原生行为）
      const nb = scanPlayerConfig();
      let playerNextId = null;
      if (nb && nb.next && nb.next.id) {
        playerNextId = String(nb.next.id);
        push('播放器给出的下一节：' + (nb.next.name || playerNextId));
      }

      // ② 接口算（能同时拿到 section_id，用来拼 URL）
      if (CLASSROOM) {
        const data = await fetchChapter();
        if (data) {
          const list = flatten(data);
          const sched = await fetchSchedules();
          const curIdx = list.findIndex((x) => x.id === String(CUR_LEAF));
          if (curIdx < 0) {
            push(`接口目录里没找到当前节 ${CUR_LEAF}，改用 DOM`);
          } else {
            // 优先：紧跟其后的未完成可播放单元
            let target = null;
            for (let i = curIdx + 1; i < list.length; i++) {
              const x = list[i];
              if (x.type !== 0 && x.type !== 1) continue;      // 只看视频/音频
              if (leafDoneById(sched, x.id)) continue;
              target = x; break;
            }
            // 播放器已给出下一节时，以播放器的判断为准（它只按顺序取，不管进度）
            if (playerNextId) {
              const byPlayer = list.find((x) => x.id === playerNextId);
              if (byPlayer && !leafDoneById(sched, byPlayer.id)) target = byPlayer;
            }
            // 后面都完成了 → 回头找全局第一个未完成
            if (!target) {
              target = list.find((x) => (x.type === 0 || x.type === 1) && !leafDoneById(sched, x.id)) || null;
            }
            if (target) {
              const remain = list.filter((x) =>
                (x.type === 0 || x.type === 1) && !leafDoneById(sched, x.id)).length;

              // 关键防护：目标若是"当前这一节"或"已去过且仍未完成"的，说明服务端进度没涨。
              // 此时直接跳到当前节会把同一节重播，形成无限循环——必须往后推进。
              const isStuck = String(target.id) === String(CUR_LEAF) ||
                visited.has(String(target.id));

              if (isStuck) {
                push(`「${target.name}」进度未更新（可能不计分），跳过它继续往后找`);
                visited.add(String(target.id));
                saveVisited(visited);
                const skips = visited.size;
                const after = list.find((x) =>
                  (x.type === 0 || x.type === 1) &&
                  !leafDoneById(sched, x.id) &&
                  !visited.has(String(x.id)));
                if (after) {
                  target = after;
                  push(`改去：${after.name}`);
                } else {
                  push(`已跳过 ${skips} 个不涨进度的单元，没有更多可播的了`);
                  push('可能这些单元不计分，或需要手动完成。已停止。');
                  setSt('需人工介入');
                  stop();
                  return;
                }
              }

              const url = buildUrl(target);
              push(`进入下一节（剩 ${remain}）：${target.name}`);
              push('跳转 ' + url.replace(location.origin, ''));
              setTimeout(() => { location.href = url; }, 600);
              return;
            }
            push('🎉 所有视频/音频单元都已完成');
            setSt('全部完成');
            stop();
            return;
          }
        }
      }

      // ③ DOM 兜底
      const dom = collectDom();
      if (dom.length) {
        const t = dom.find((x) => !x.done);
        if (!t) { push('🎉 目录内已全部完成'); setSt('全部完成'); stop(); return; }
        push('点目录进入：' + t.title);
        humanClick(t.n);
        return;
      }

      // 全都拿不到，给可执行的提示
      push('无法确定下一节：没抓到目录接口，且当前页没有目录树');
      push('请手动回到课程目录页点一次「开始」，之后会自动串联');
      setSt('需要目录页');
    } catch (e) {
      push('下一节出错：' + (e.message || e));
    } finally {
      advancing = false;
    }
  };

  /* ═══════════ 6. 面板 ═══════════ */

  const buildPanel = () => {
    if (document.getElementById('ykt-ka')) return;
    const el = document.createElement('div');
    el.id = 'ykt-ka';
    el.innerHTML = `
      <style>
        #ykt-ka{position:fixed;right:14px;bottom:14px;width:318px;z-index:2147483600;
          font:12px/1.55 "Microsoft YaHei",system-ui;color:#22302c;background:#fff;
          border:1px solid #d6dde3;border-radius:10px;overflow:hidden;
          box-shadow:0 8px 28px rgba(0,0,0,.18)}
        #ykt-ka .hd{display:flex;justify-content:space-between;align-items:center;
          padding:8px 10px;background:#1f7a4d;color:#fff;font-weight:600}
        #ykt-ka .hd b{cursor:pointer;opacity:.85;font-weight:400}
        #ykt-ka .bd{padding:8px 10px}
        #ykt-ka .st{margin-bottom:6px;color:#3d4b46}
        #ykt-ka .st i{color:#1f7a4d;font-style:normal;font-weight:600}
        #ykt-ka .lg{height:150px;overflow:auto;background:#f5f8f7;border:1px solid #e5ebe8;
          border-radius:6px;padding:6px;font:11px Consolas,monospace;color:#37453f}
        #ykt-ka button{width:100%;margin-top:8px;padding:7px;border:0;border-radius:6px;
          background:#1f7a4d;color:#fff;cursor:pointer;font-size:12px}
        #ykt-ka button.off{background:#ad3b2c}
        #ykt-ka label{display:flex;gap:6px;align-items:center;margin-top:7px;color:#6b7772;font-size:11px}
        #ykt-ka .tip{margin-top:5px;color:#95a09a;font-size:11px}
      </style>
      <div class="hd">雨课堂 · 播放保活 v3 <b id="ka-min">—</b></div>
      <div class="bd">
        <div class="st">状态 <i id="ka-st">待机</i>　心跳 <span id="ka-beat">0</span></div>
        <div class="lg" id="ka-log"></div>
        <button id="ka-btn">开始</button>
        <label><input type="checkbox" id="ka-aud" checked> 保持“可听”以防后台冻结</label>
        <div class="tip">1x 真实播放，切后台不暂停，播完自动下一节。</div>
      </div>`;
    document.body.appendChild(el);
    panelLog = el.querySelector('#ka-log');
    statusEl = el.querySelector('#ka-st');
    btnEl = el.querySelector('#ka-btn');
    beatEl = el.querySelector('#ka-beat');

    el.querySelector('#ka-aud').onchange = (e) => {
      keepAudible = e.target.checked;
      push('可听保活：' + (keepAudible ? '开' : '关'));
    };

    let folded = false;
    el.querySelector('#ka-min').onclick = () => {
      folded = !folded;
      el.querySelector('.bd').style.display = folded ? 'none' : '';
      el.querySelector('#ka-min').textContent = folded ? '+' : '—';
    };
    btnEl.onclick = () => (running ? stop() : start());
  };

  const setSt = (s) => { if (statusEl) statusEl.textContent = s; };

  /* ═══════════ 7. 主循环 ═══════════ */

  let busy = false;

  const tick = async () => {
    if (!running || busy) return;
    busy = true;
    try {
      const v = pickVideo();
      if (v) {
        hook(v);
        toastUp(v);
        if (v.paused && !v.ended && Date.now() - userPauseAt > 1500) {
          v.play().catch(() => { });
        }
        const dur = Math.round(v.duration || 0);
        const cur = Math.round(v.currentTime || 0);
        setSt(`${v.paused ? '暂停' : '播放'} ${cur}/${dur}s ×${v.playbackRate}`);
      } else {
        setSt('等待播放器');
      }
      if (beatEl) beatEl.textContent = String(beatCount);
    } catch (_) { } finally {
      busy = false;
    }
  };

  const start = () => {
    running = true;
    if (btnEl) { btnEl.textContent = '停止'; btnEl.classList.add('off'); }
    setSt('运行中');
    push('已启动');
    const v = pickVideo();
    if (v) { hook(v); v.play().catch(() => push('自动播放被拦，点一下视频区域')); }
  };

  const stop = () => {
    running = false;
    if (btnEl) { btnEl.textContent = '开始'; btnEl.classList.remove('off'); }
    setSt('已停止');
    push('已停止');
  };

  // 区分「用户主动暂停」与「站点强制暂停」
  window.addEventListener('click', (e) => {
    const t = e.target;
    if (t && t.closest && t.closest('[class*="play_btn"],[class*="playbutton"],[class*="xt-playbutton"]')) {
      userPauseAt = Date.now();
    }
  }, true);

  /* ═══════════ 8. 启动 ═══════════ */

  const boot = () => {
    if (!document.body) return setTimeout(boot, 200);
    buildPanel();
    push('就绪：点「开始」，或直接打开视频页');
    setInterval(tick, 1500);

    // 自动启动：不依赖 URL 猜测，只看「页面上是否真的出现播放器」。
    // 这样 lms / ai-workspace / iframe 内嵌播放器都能覆盖。
    let tries = 0;
    const watch = setInterval(() => {
      tries++;
      if (pickVideo()) {
        clearInterval(watch);
        if (!running) { push('检测到播放器，自动启动'); start(); }
        return;
      }
      if (tries > 60) clearInterval(watch);   // 约 30 秒后放弃
    }, 500);

    // URL 命中视频页时提前启动，抢在轮询之前
    if (/lms-|ai-workspace|\/video\/|courseware/.test(location.href)) {
      setTimeout(() => { if (!running) start(); }, 1000);
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else { boot(); }

  // 控制台可用的诊断入口
  window.__yktKA = {
    start, stop, log: LOG,
    video: () => pickVideo(),
    stats: () => ({
      running,
      beats: beatCount,
      lastBeatAgo: lastBeat ? ((Date.now() - lastBeat) / 1000).toFixed(1) + 's' : '从未',
      lastBeatStatus,
      workerTicks: workerTicks.length,
      rate: pickVideo() ? pickVideo().playbackRate : null,
      paused: pickVideo() ? pickVideo().paused : null,
    }),
  };
})();
