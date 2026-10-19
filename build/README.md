# 构建与源码改动说明（st-immersive-sound-fix）

## 为什么有这个目录

上游仓库只发布了**混淆后的 `index.js`**，没有提交构建脚本，也没有入口源码。
`package.json` 里 `npm run obfuscate` 指向的 `obfuscate.js` 在仓库中并不存在。

这导致任何功能改动都只能**往混淆产物尾部追加 monkey-patch**。
本目录补上了缺失的构建链路，使改动可以直接写在源码里。

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `../index.src.js` | esbuild 入口源码。从已发布 `index.js` 的 bundle 中反混淆还原，并已把补丁改为直接源码改动。放在插件根目录（与 `utils/` 同级）以匹配原有 `../../../extensions.js` 相对路径。 |
| `../build.js` | 构建脚本：esbuild 打包 → 写出 `index.js`（**不做混淆**，见下）。 |
| `entry.deobfuscated.js` | 入口区反混淆的原始产物（仅供追溯，不参与构建）。 |
| `index.orig-backup.js` | 改动前的原始 `index.js` 备份。 |

## 构建

```bash
npm install     # 首次
npm run build   # 生成 index.js
```

## 关键实现细节

### 入口的 externals

`../../../extensions.js`、`../../../../script.js`、`../../../st-context.js`
由 SillyTavern 宿主提供，必须保持 external，不能打进产物。

### ⚠️ 宿主模块的 import 层级必须归一化（跨平台构建陷阱）

这三个路径是**相对入口文件**（位于插件根目录）的写法。但 `utils/` 下的文件
层级更深，它们写的是：

| 写法 | 出现位置 | 处数 |
| --- | --- | --- |
| `../../../../../script.js` | `utils/*.js` | 28 个文件 |
| `../../../../extensions.js` | `utils/*.js` | 40 处 |
| `../../../../st-context.js` | `utils/*.js` | 3 处 |
| `../../../../../../script.js` | `utils/ai-assistant/*.js` | 2 处 |

如果 `EXTERNAL` 只列入口层级的那三条，这些更深的写法**不匹配任何 external**，
esbuild 就会把它们当普通相对路径、按**源码文件所在层级**重写，产物里出现
`../../../script.js` —— 从插件根目录解析到
`SillyTavern/public/scripts/script.js`，**该文件并不存在，插件加载即失败**。

**平台相关性（最坑的一点）**：macOS 上 esbuild 恰好归一化到 4 层（合法），
Linux 上归一化到 3 层（非法）。同一份源码在两个平台产出**不同的 import 图**，
在 macOS 上构建看不出来，换到 Linux 就坏。

因此 `build.js` 里用 esbuild 插件 `normalizeHostImports` 把所有层级的宿主模块
写法**统一归一化到入口层级**，并对产物做白名单校验——任何不在 `EXTERNAL` 里的
相对 import 一律构建失败。

**验证方法**：构建后确认产物里只剩这三种合法写法，且都能从插件根目录解析到
真实文件；或直接对比 Linux 与 macOS 的 esbuild 阶段产物是否字节一致
（修复后：md5 `ea2158bec2958c995053df5974165b13`）。

### esbuild 内部标识符必须消除

原 bundle 里存在 esbuild 的模块注册标识符（`lyrics_player_exports` /
`init_lyrics_player` / `sequential_audio_engine_exports` /
`init_sequential_audio_engine` / `newline_fix_exports` / `init_newline_fix` /
`offline_renderer_exports` / `init_offline_renderer`）。

从 bundle 反混淆还原入口时，这些标识符**没有对应的定义**。
esbuild 会把未知标识符当作全局变量而**静默放过**，结果是相关模块
（如 `utils/lyrics-player.js`）根本不会进入产物，而构建不报任何错。

因此 `index.src.js` 中已把它们替换为真实的命名导入：

```js
// 原来（bundle 内部形式，重建后无定义）
const { LyricsPlayer } = await Promise["resolve"]()["then"](() => (init_lyrics_player(), lyrics_player_exports))

// 现在（真实导入，见 index.src.js 顶部）
import { LyricsPlayer } from './utils/lyrics-player.js';
const { LyricsPlayer: LP } = Promise.resolve({ LyricsPlayer });
```

**验证方法**：构建后用 `metafile` 检查 `utils/lyrics-player.js` 是否在
`inputs` 列表中；或直接在未混淆产物里 grep `st-is-lyrics-titlebar`。

### 入口必须能从 `utils/` 解析到所有依赖

反混淆还原的入口会引用一些**未在 import 列表中**的函数（例如 `loadAudio`、
`initAiAssistant`）。缺失的导入同样会被 esbuild 当作全局变量静默放过，
运行时才报 `is not defined`。当前已补齐 `loadAudio` 等。

## 已源码化的四处改动

原先它们是追加在 `index.js` 尾部的四段 IIFE（共 10,538 字节）。

### 1. 歌词播放器拖拽增强 → `utils/lyrics-player.js`（`_createDOM` 内）

- 新增 `clampToViewport(left, top)`：标题栏完整留在屏内，水平至少保留
  `min(cw/2, 200)` 可见宽度，顶部不越出上边缘。
- 新增 `isOffscreen()`：判断窗口是否已出屏。
- 新增 `DRAG_EXCLUDE`：按钮 / 进度条 / 音量面板 / 右键菜单不触发拖拽。
- 监听器从标题栏改绑到**容器的 capture 阶段**，使标题栏与（出屏时的）
  歌词区都能作为拖拽把手。
- 歌词内容区仅在窗口已出屏时才接管拖拽，否则放行原生滚动。

### 2. mini 小窗模式 → `utils/lyrics-player.js` + `css/lyrics-player.css`

- 标题栏新增 `lp-mini-toggle` 按钮，切换 mini / 完整模式。
- 新增 `lp-mini-current-line` 元素显示当前高亮歌词。
- 新增 `_toggleMini()` 与 `_syncMiniCurrentLine()`。
- `_updateLineHighlights()` 末尾在 mini 下调用 `_syncMiniCurrentLine()`。
- CSS 中新增 `.st-is-lyrics-player.lp-mini` 规则（见下）。
- 默认进入 mini 模式。

### 3. mini 下音量面板被裁剪 → `css/lyrics-player.css`

根因：`.st-is-lyrics-player` 带 `overflow: hidden`，mini 小窗高度不足以
容纳向下展开的音量面板。源码层直接放开：

```css
.st-is-lyrics-player.lp-mini {
    width: 380px;
    height: auto;
    max-height: 90vh;
    overflow: visible;   /* 关键 */
}
```

`overflow` 放开后圆角由首尾元素自行绘制（`border-radius` 补偿规则），
不再需要 `!important` 覆盖。

### 4. 双击停止后无法恢复播放 → `index.src.js`（会话管理段）

根因：`cancelImmersiveSoundSession()` 会自增会话计数器，使播放引擎持有的
`playbackSessionId` 失效；再点播放时 `resume` → `playList` 调用
`isSessionActive(旧 id)` 返回 false 而被 abort，音频无法启动。

源码层修复（不再靠 hook `window.*`）：

```js
var resumedSessionId = null;

function cancelImmersiveSoundSession() {
    const stoppedMarker = window.marker || marker;
    if (stoppedMarker && stoppedMarker.options && stoppedMarker.options.playbackSessionId != null) {
        resumedSessionId = stoppedMarker.options.playbackSessionId;
    } else if (Number.isFinite(activeImmersiveSoundSessionId)) {
        resumedSessionId = activeImmersiveSoundSessionId;
    }
    activeImmersiveSoundSessionId = ++immersiveSoundSessionCounter;
    stopAllAudio(stoppedMarker);
    window.marker = null;
    return activeImmersiveSoundSessionId;
}

function isImmersiveSoundSessionActive(sessionId) {
    if (!Number.isFinite(sessionId)) return true;
    if (resumedSessionId !== null && sessionId === resumedSessionId) return true;  // 放行
    return sessionId === activeImmersiveSoundSessionId;
}
```

## 顺带修复的上游缺陷

`utils/lyrics-player.js` 中 `_updateLineHighlights` 与 `_scrollToActiveLine`
各定义了**两次**。JS 类体中后定义者生效，前者是永不执行的死代码。
按 C 依赖的 `st-is-lyrics-line-active` 类在 CSS 中引用数为 0 —
即旧实现从未生效。已删除两份死代码。

## 回归验证

构建无警告后，用 DOM stub 实例化 `LyricsPlayer` 实测：

- `isMini` 默认 `true`，容器带 `lp-mini` ✅
- `_toggleMini()` 来回切换，类名同步 ✅
- 手动高亮第 2 行 → 单行显示 `"第二句歌词"` ✅
- 无高亮 → 降级 `"-"` ✅
- `_updateLineHighlights(2)` → 单行显示 `"第三句歌词"` ✅
- 拖拽监听绑定在**容器 capture 阶段** ✅
- 拖至左上极值 → 夹紧为 `left=-280px, top=0` ✅
- 拖至右下极值 → 夹紧为 `left=1080px, top=760px`（1280×800 视口）✅

## 真机验证（Ubuntu 上的 SillyTavern）

在**隔离的测试插件**上验证重建产物，未触碰正在使用的插件：

- 测试插件路径：`~/SillyTavern/public/scripts/extensions/third-party/st-immersive-sound-test`
- 重建的 `index.js` **成功加载**，浏览器实际拉取了 `index.js` + `style.css`
- **零运行时错误**（控制台只有 ST 自身的 preload 警告）
- 插件完成初始化：settings modal 已创建；
  `cancelImmersiveSoundSession` / `isImmersiveSoundSessionActive` 为 live function
- mini 模式 8 条 CSS 规则在浏览器中生效，含关键修复
  `.st-is-lyrics-player.lp-mini { overflow: visible !important }`
- 原有两个插件 `st-immersive-sound` 与 `st-immersive-sound-fix`
  经 md5 比对**字节未变**

> **踩坑记录**：用带内嵌凭据的 URL 导航（`http://user:pass@host/`）会让页面内的
> 相对 fetch 全部失败，表现为**所有** third-party 插件都"加载不出来"。
> 必须用干净 URL 导航、让浏览器自己处理 basic auth，否则会误判插件坏了。

## 第二轮修复：反混淆还原丢失的定义（真机功能验证后）

第一轮"加载成功、零控制台错误"是**假阴性**——悬浮球不显示、设置面板打不开。
真正的错误不在 console 里，而是被 `cocktail-plus` 插件的 beacon 上报走了
（`/api/plugins/cocktail-plus/browser-logs/beacon`，URL 参数里带 URL-encoded 堆栈）。
用网络抓包才看到：`Uncaught ReferenceError: _0x4edb4c is not defined`。

### 根因（三类，全部修复）

1. **字符串解码器别名 `_0x4edb4c` 定义丢失**。入口里残留 9 处死别名赋值
   （`const X=_0x4edb4c,` ×6、`const X=_0x4edb4c;` ×3），第一条语句就抛
   ReferenceError，`initUI()` 永远执行不到。连带 6 个二级死别名链
   （`_0x5f0e00`/`_0x1eb184` 等，只被赋值从不被调用），共 28 处传递清理。
   **修复只能用精确字符串替换**——宽泛正则会误删同名但合法的绑定
   （如 `const _0x2f2ba2=_0x929542` 是真实对象），已踩过两次。

2. **3 个宿主模块局部别名丢失**（入口顶部其实已 import）：
   `_0x4b89b6`→`extension_settings`(24处)、`_0x570776`→`eventSource`(13处)、
   `_0x5e841f`→`getContext`(1处)。直接全局替换回真实名。

3. **4 个函数从未 import**（修完 1 才暴露）：
   `initAiAssistant`(ai-assistant/index.js)、`findVoiceByName`(minimax-voices.js)、
   `findVoiceByName2`/`getCurrentVoiceId2`(nimo-voices.js；`_2` 是 esbuild 对
   同名导入的去重后缀)。用 AST 扫"被调用但未声明"一次性找全。

### 修复后真机验证（隔离测试插件，禁用另外两个变体）

- 悬浮球渲染（`#st-is-float-ball`，display:flex，53×53px）✅
- 菜单项「打开声临其境设置」注入 ✅
- `showYinXiaoSettingsPanel()` 打开面板，内容完整渲染（截图确认）✅
- 零 ReferenceError ✅
- esbuild 产物 1,108,669 → 1,175,541 字节（补回缺失模块）✅

### 验证方法论教训

- **"元素存在"≠"功能正常"**：悬浮球可能是别的插件变体创建的（三个变体共享
  `extensionName="st-immersive-sound"`、DOM id 和全局函数，同时启用会互相覆盖）。
- **ST 的 console 未必显示插件错误**：cocktail-plus 会把错误 beacon 走，
  必须 `bsk network` 抓包看。
- 用 AST 静态扫"called-but-undeclared"比按运行时错误逐个试快得多。

### 插件变体互斥

原版 / fix / test 三个变体的 `extensionName` 相同，共享 settings key 与 DOM id，
**同时启用会互相覆盖**。测试重建产物时必须在 ST 设置里禁用另外两个
（`disabledExtensions` 在 `data/default-user/settings.json` 的
`extension_settings` 子键下，且 ST 会在某些操作后从磁盘重载，需重新确认）。

## 第三轮修复：播放器 "not a constructor" 与放弃混淆

### 播放链路故障（真机日志定位）

用户实测：BGM 解析、33 段 TTS、`play-sound` 事件全部正常，但
`new LyricsPlayer(...)` 报 `TypeError: _0x4f6eab is not a constructor`。
排查证明两个类在产物里定义正常（顶层 `var X = class {}`，探针
`typeof === "function"`），同一份源码上一轮构建能播、这一轮坏——
差异只在混淆器每次不同的随机产物。结论：**javascript-obfuscator
非确定性产物偶发损坏**（故障点在解构 `Promise.resolve({X})`）。

### 根治：清除全部 `Promise.resolve({X})` 残渣 + 放弃混淆

- 源码里 4 处 `Promise.resolve({X})` 包裹是反混淆还原时留下的
  **无操作残渣**（esbuild 惰性初始化模式的等价替换，非业务逻辑），
  全部清除，直接引用真实类名。教训：**反混淆还原源码时，构建工具链
  的内部机制必须清除而不是保留**——它们是混淆器损坏时的单点故障面。
- **彻底移除 javascript-obfuscator**：seed 实测不生效、产物不可复现、
  git diff 不可审阅、偶发产出损坏构建。自用 fork 混淆无收益。
  现在产物 = esbuild 原始输出，**字节级可复现**（连续构建 md5 相同），
  可读、可审阅、可 debug。

### 播放链路验证

用户真机实测通过：LLM 回复 BGM JSON → 双击触发 → TTS 生成 →
歌词播放器调起 → 正常播放。

## 已知未解决问题

1. **没有自动化测试**：`package.json` 的 `test` 脚本指向 `tests/`，但该目录不存在，
   `npm test` 必然失败。上面的回归验证目前仍是手工执行。
