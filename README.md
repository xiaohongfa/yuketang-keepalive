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

---

## 修复原理

| 问题 | 做法 |
| --- | --- |
| 切后台暂停 | 伪装 `document.hidden` / `visibilityState`；捕获阶段拦截 `blur` / `focusout` / `pagehide` / `visibilitychange`；拒绝对 `onblur`、`onfocusin` 等属性赋值 |
| 被强制暂停 | 监听 `pause`，0.15 秒内自动续播；用户主动点暂停时保留 1.5 秒窗口，不硬顶 |
| 后台计时器被节流 | 用 Web Worker 计时器保活（后台标签页的 `setInterval` 会被限流到 1 次/分钟） |
| 倍速折算 | 锁定 1x；若检测到其他脚本抢倍速则自动退让，避免打架 |
| 自动播放 | 页面上出现 `<video>` 即接管，不依赖 URL 猜测 |
| 自动下一节 | 按真实 DOM 结构定位目录项，播完进入下一个未完成单元 |

事件拦截只在页面存在播放器时生效，不影响登录页与验证码。

---

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展。
2. 打开 [`yuketang-keepalive.user.js`](./yuketang-keepalive.user.js)，点击 Raw，Tampermonkey 会弹出安装界面。
3. 确认安装。

打开任意雨课堂视频页即可自动运行。右下角会出现面板，显示播放状态与心跳计数。

## 使用

- **自动**：进入视频页后面板自动启动。
- **手动**：点面板上的「开始」。
- **自动下一节**：在**课程目录页**点「开始」，脚本会依次进入未完成的单元。

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

脚本本身不含任何网络请求代码：

- 无 `http://` / `https://` / IP 字面量
- 无第三方域名、无 `@connect`、`@grant none`
- 无 `eval` / `new Function` / 动态插入 script
- 不读取 `document.cookie`

它对 `fetch` 与 `XMLHttpRequest` 只做**只读观察**（读取 URL 判断是否为心跳、统计次数），不改写请求内容与响应。

实测对照：同一页面在安装与不安装脚本两种情况下，真实网络请求数、目标主机、路径完全一致。

---

## 已知限制

- 自动下一节的目录选择器依赖站点模板的 DOM 结构（`.leaf-detail` + `.icon--shipin` + `.study-progress`）。站点改版后可能需要调整。
- 播放器位于跨域 iframe 时，依赖用户脚本在子帧内也注入（Tampermonkey 默认行为）。
- 仅对「视频 / 音频」类型单元生效，跳过直播与图文。

## License

MIT
