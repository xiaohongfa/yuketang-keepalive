# 雨课堂 播放保活

一个 Tampermonkey 用户脚本，解决雨课堂（yuketang.cn）在线视频的两个常见问题：

- **切到后台视频就暂停**
- **完成率一直不动**

脚本只做「真实播放」——不伪造心跳、不改服务端请求、不跳进度。它靠修正浏览器的行为，让原本该记录的学习时长被正常记录。

---

## 问题根因

两个症状来自同一套前端设计，均可在站点 bundle 中定位。

### 1. 切后台自动暂停

播放器的 `winTriggerHidden()` 会把焦点/可见性变化映射为 `hidden`，命中后强制暂停：

```js
o = { focus:'visible', focusin:'visible', pageshow:'visible',
      blur:'hidden',  focusout:'hidden', pagehide:'hidden' }
// 命中 hidden → $video.trigger('playBtn.toggle', { xtStateType: 'pause' })
```

除 `visibilitychange` 外，它还直接挂在 `document.onfocusin`、`document.onfocusout`、`window.onblur` 等属性上。

### 2. 完成率不动

心跳函数 `sendEvents` 里有两个门：

```js
// 进度连续 10 次不前进 → 强制暂停播放器
s.timeNoUpdateNum <= 10 ? (正常发送) : $video.trigger('playBtn.toggle', { xtStateType: 'pause' })

// 距上次发送不足 sendInterval（30 秒）→ 只写 localStorage，不发请求
(sendTime 间隔 < sendInterval) ? 只缓存 : 真正 POST
```

视频一旦被暂停，`currentTime` 不再前进 → `timeNoUpdateNum` 累加到 10 → 播放器被再次强制暂停，心跳彻底断掉。服务端拿不到连续的 `cp`（当前秒数），完成率自然不动。

另外，**倍速会被折算**：心跳里带 `sp` 字段，2 倍速下记录的有效时长只有一半。

### 3. 播完不会自动下一节

新版播放页（`/ai-workspace/lms-graph/{classroom}/video/{leaf}`）里**没有目录树**，页面上不存在 `.leaf-detail`。任何依赖「当前页 DOM 里找目录项」的连播方案都会在这一页失效。

正确的跳转地址是构造出来的：

```
{base}/ai-workspace/lms-graph/{classroom_id}/video/{leaf_id}?is_chapter=1&node_id={section_id}
```

其中 `node_id` 就是该单元的 `section_id`（已用实际 URL 比对确认）。`section_id` 需要从目录接口取：

```
GET /mooc-api/v1/lms/learn/course/chapter?cid={classroom_id}&classroom_id={classroom_id}&sign={sign}&show_unpublished=false
GET /mooc-api/v1/lms/learn/course/schedule?cid={classroom_id}&sign={sign}&classroom_id={classroom_id}
```

后者返回 `leaf_schedules`，值是 0~1 的完成度。判定「已完成」要认 `>= 1`，页面上的表现是文本变成「已完成」。

---

## 修复原理

| 问题 | 做法 |
| --- | --- |
| 切后台暂停 | 伪装 `document.hidden` / `visibilityState`；捕获阶段拦截 `blur` / `focusout` / `pagehide` / `visibilitychange`；拒绝对 `onblur`、`onfocusin` 等属性赋值 |
| 被强制暂停 | 监听 `pause`，0.15 秒内自动续播；用户主动点暂停时保留 1.5 秒窗口，不硬顶 |
| 后台计时器被节流 | 用 Web Worker 计时器保活（后台标签页的 `setInterval` 会被限流到 1 次/分钟） |
| 倍速折算 | 锁定 1x；若检测到其他脚本抢倍速则自动退让，避免打架 |
| 自动播放 | 页面上出现 `<video>` 即接管，不依赖 URL 猜测 |
| 播完检测 | `ended` + `timeupdate` 双保险（部分播放器在跳转后 `ended` 不触发） |
| 自动下一节 | ①读播放器 `nextLeaf` → ②调目录接口算 `section_id` 并构造 URL → ③DOM 兜底 |
| 防原地循环 | 记录已访问节点；若目标进度未涨则跳过它继续往后，不会把同一节重播 |

事件拦截只在页面存在播放器时生效，不影响登录页与验证码。

跳转前会等待约 8 秒，让心跳把 `cp=duration` 上报完。否则刚看完的这一节在服务端仍是未完成，会把自己又选成「下一节」。

### 关于 `sign`

目录接口必须带 `sign`，不带时服务端会返回**被裁剪的目录**（页面上表现为「目录里没找到当前节」）。

而 `sign` 既不在页面 URL 里，也不在任何响应里 —— 它是页面自己算出来的。所以脚本的做法是**从页面自身发出的请求里抄**（`fetch` / `XHR` 都挂钩），学到后存进 `localStorage` 并跟随后续跳转传递。

如果第一次进页面时页面还没请求过目录，脚本会在 2.5s / 12s 各预取一次，并主动拉一次课程目录页触发站点自己发请求。

---

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展。
2. 打开 [`yuketang-keepalive.user.js`](./yuketang-keepalive.user.js)，点击 Raw，Tampermonkey 会弹出安装界面。
3. 确认安装。

打开任意雨课堂视频页即可自动运行。右下角会出现面板，显示播放状态与心跳计数。

## 使用

- **自动**：进入视频页后自动启动。
- **自动连播**：播完等 8 秒后自动进入下一个未完成单元，可无人值守。
- **手动跳过**：面板日志会显示「跳过 X（进度未更新）」。

面板折叠后只留标题栏；日志区会显示心跳次数、倍速纠偏、暂停续播等动作。

控制台诊断：

```js
__yktKA.stats()
// { running, beats, lastBeatAgo, lastBeatStatus, workerTicks, rate, paused }
```

---

## 重要提醒

**把其它刷课插件的倍速改成 1x。** 常见的「雨课堂刷课助手」默认 2 倍速且发送不了心跳，两者叠加时完成率不会上涨。可以在它的面板里改，或执行：

```js
localStorage.setItem('ykt_playback_rate', '1')
```

**心跳间隔是 30 秒。** 这意味一个 10 分钟的视频至少要真实播放 10 分钟才能记录完整，没有捷径，只能挂着。脚本不提供、也不建议伪造进度。

**不能绕过反作弊。** 站点存在 `/c27/anti-cheat/config` 与 `/c27/anti-cheat/evidence/` 上报通道。若课程启用了证据采集，服务端会比对心跳节奏与事件序列，仅靠前端伪装无法规避。

---

## 安全性

脚本不连任何第三方：

- 无 `http://` / `https://` / IP 字面量 —— 所有请求都用相对路径，只打当前站点
- 无第三方域名、无 `@connect`、`@grant none`
- 无 `eval` / `new Function` / 动态插入 script
- 不读取 `document.cookie`

对 `fetch` 与 `XMLHttpRequest` 只做**只读观察**（读取 URL 判断是否为心跳、统计次数），不改写请求内容与响应。

唯一主动发起的请求，是读取课程目录与进度（`/mooc-api/v1/lms/learn/course/chapter`、`/schedule`）。这两个是站点自己的只读 GET 接口，同源、带 `credentials: 'include'` 复用你自己的登录态，不向任何第三方发送数据。

实测对照：同一页面在安装与不安装两种情况下，真实网络请求数、目标主机、路径完全一致（仅在需要连播时才额外请求目录接口）。

---

## 已知限制

- 连播依赖站点的目录接口结构（`course_chapter[].section_leaf_list[].leaf_list[]`）。站点改版后可能需要调整。
- 若某一节的进度始终不涨（比如该单元不计分），脚本会跳过它继续往后，不会卡死；跳过记录存在 `localStorage` 的 `ykt_ka_visited`。
- 播放器位于跨域 iframe 时，依赖用户脚本在子帧内也注入（Tampermonkey 默认行为）。
- 仅对「视频 / 音频」类型单元生效（`leaf_type` 0/1），跳过直播与图文。

## License

MIT
