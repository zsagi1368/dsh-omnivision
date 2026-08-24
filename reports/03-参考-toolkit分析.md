# dsh-vision-toolkit 深度研究报告

> 分析对象：`@anionex/dsh-vision-toolkit` v0.1.38  
> 上游仓库：[Anionex/agent-vision-toolkit](https://github.com/Anionex/agent-vision-toolkit)  
> 分析日期：2026-08-21  
> 研究者：Agnes (Hermes Agent)

---

## 一、架构概述

### 1.1 项目定位

dsh-vision-toolkit 是 DeepSeek Harness（DSH）的原生视觉插件，将上游 Python 库 `agent-vision-toolkit` 的能力包装为 DSH 原生工具（Native Tools），并提供 Skill 指导、配置管理、浏览器截图、Artifact 交付等完整集成。

**核心价值主张：**
- 为纯文本 LLM（如 DeepSeek-R1）赋予"眼睛"
- 内置免费 Vision 服务（vision.anionex.me + Gemini 3.7 Flash，每日 100 张/机器限额）
- 通过 Skill 系统引导模型按任务选择工具
- 渐进式工具暴露（Progressive Tools）

### 1.2 整体架构分层

```
┌─────────────────────────────────────────────────────────────┐
│                    DSH Plugin Layer                         │
│  src/index.ts (apply function)                             │
│  ├─ Config / Settings (schemastery schema)                  │
│  ├─ Runtime Manager (prepare-before-swap)                   │
│  ├─ Tool Exposure (progressive, agent-scoped)               │
│  ├─ Artifact Access Controller                              │
│  └─ Web Backend (pasted-images, variants)                   │
├─────────────────────────────────────────────────────────────┤
│                    TypeScript Runtime                        │
│  src/runtime.ts (VisionToolkitRuntime class)                │
│  ├─ Semaphore (FIFO concurrency gate per session)           │
│  ├─ CompressedImageCache (L1 cache)                         │
│  ├─ GlanceCache (per-session glance result cache)           │
│  ├─ PathPolicy (workspace-strict path validation)           │
│  └─ UpstreamAdapter (subprocess → Python CLI)               │
├─────────────────────────────────────────────────────────────┤
│                  Python Upstream (vendor/)                   │
│  vendor/agent-vision-toolkit/                               │
│  ├─ vision_client.py (multi-provider HTTP client)           │
│  ├─ bin/glance, ground, detect, crop, trace (entry scripts) │
│  ├─ skills/vision-tools/scripts/                            │
│  │   ├─ long_screenshot_ocr.py                              │
│  │   ├─ pixel_diff.py                                       │
│  │   ├─ extract_fg.py                                       │
│  │   ├─ dominant_colors.py                                  │
│  │   └─ html_shot.py                                        │
│  └─ UPSTREAM_MANIFEST.json (SHA256-verified pin)            │
└─────────────────────────────────────────────────────────────┘
```

### 1.3 关键技术特性

| 特性 | 实现方式 |
|------|---------|
| **渐进式工具暴露** | 工具只在加载 `vision-skills` Skill 后才注册到当前 Agent，bootstrap tool `vision_toolkit_activate` 可作为备用激活入口 |
| **Prepared-before-swap 更新** | 新配置先 prepare（含上游校验），成功后原子替换 active runtime，失败则保留旧版本 |
| **SHA256 上游锁定** | `UPSTREAM_MANIFEST.json` 记录每个文件的精确 SHA256，启动时验证完整性 |
| **FIFO 并发门控** | 每 session 一个 Semaphore，排队调用支持取消（AbortSignal） |
| **路径严格管控** | PathPolicy 限制所有输入/输出必须在 workspace 或 allowedDirs 内，拒绝符号链接逃逸 |
| **内置免费服务** | 默认使用 `vision.anionex.me` + Gemini 3.7 Flash，无需用户配置 API Key |

---

## 二、10 个视觉工具详细分析

### 2.1 工具总览

| # | 工具名 | 名称常量 | 类型 | 核心功能 |
|---|--------|---------|------|---------|
| 1 | vision_glance | VISION_TOOL_NAMES.glance | 远程 | 图像问答、OCR、描述 |
| 2 | vision_ground | VISION_TOOL_NAMES.ground | 远程 | 定位单个目标 |
| 3 | vision_detect | VISION_TOOL_NAMES.detect | 远程 | 枚举所有同类元素 |
| 4 | vision_trace | VISION_TOOL_NAMES.trace | 本地 | 矢量追踪 → SVG |
| 5 | vision_crop | VISION_TOOL_NAMES.crop | 本地 | 像素裁剪 |
| 6 | vision_pixel_diff | VISION_TOOL_NAMES.pixelDiff | 本地 | 像素级图像对比 |
| 7 | vision_long_screenshot_ocr | VISION_TOOL_NAMES.longScreenshotOcr | 远程+本地 | 长截图 OCR 流水线 |
| 8 | vision_extract_foreground | VISION_TOOL_NAMES.extractForeground | 本地 | 前景提取 → 透明 PNG |
| 9 | vision_dominant_colors | VISION_TOOL_NAMES.dominantColors | 本地 | 主色调分析 |
| 10 | vision_html_screenshot | VISION_TOOL_NAMES.htmlScreenshot | 本地+Chrome | HTML → 截图 |

### 2.2 各工具详细分析

#### vision_glance — 图像问答

**调用方式：**
```json
{
  "images": ["image.png"],
  "query": "Where is the error message?",
  "ocr": false,
  "region": "100,50,400,300",
  "timeoutMs": 30000
}
```

**内部流程：**
1. 路径校验 → PathPolicy 检查
2. 可选压缩（maxImageBytes: 4MB, maxImagePixels: 20M）
3. L1 缓存命中检查（基于内容 SHA256 + evidenceFingerprint）
4. 会话级 GlanceCache 命中检查
5. 并发门控 Semaphore.acquire()
6. Subprocess 调用 `bin/glance` Python CLI
7. 解析 stdout → GlanceResult
8. 写入 structured result

**Prompt 构建：**
- 无 query → "Please describe the contents of this image in detail"
- query → 直接作为问题
- ocr → 详细 OCR 指令（逐行转录，不改写不翻译）
- 多图比较 → 分别描述后指出差异

**限制：** region 只能用于单图；OCR 和 query 互斥

#### vision_ground — 目标定位

**调用方式：**
```json
{
  "image": "screenshot.png",
  "target": "the send button",
  "region": "100,50,400,300",
  "preview": true,
  "previewOutput": "button-preview.png"
}
```

**内部流程：**
1. 调用 `ground.py` → 返回 JSON box_2d 数组
2. 坐标从 0-1000 网格缩放回原图像素
3. 支持 `VISION_BOX_ORDER` 环境变量（xyxy vs yxyx），自动根据模型名判断

**输出：**
```json
{
  "target": "the send button",
  "image": { "path": "...", "width": 1920, "height": 1080 },
  "imageWidth": 1920,
  "imageHeight": 1080,
  "matches": [
    { "label": "send button", "box": { "x1": 1067, "y1": 841, "x2": 1108, "y2": 881 } }
  ],
  "preview": { /* ArtifactDescriptor */ }
}
```

**坐标系统：** 原始像素坐标，基于原图尺寸，非压缩后尺寸

#### vision_detect — 元素盘点

与 ground 类似，但目标是"类别"而非具体名称：
- 无 category → "every distinct UI element"
- 有 category → 枚举该类所有实例
- 输出带编号和可见标签

#### vision_trace — 矢量追踪

**核心算法：** 使用 upstream 的 vtracer 流水线
- 支持 `--polygon` 模式（适合方框图表）
- 支持区域裁剪
- 输出 SVG Artifact + geometry 统计

**限制：** 仅适用于扁平高对比度图形，文字会变成曲线

#### vision_crop — 像素裁剪

**核心逻辑：**
- 接收 x1,y1,x2,y2 字符串
- 自动 clamp 到图像边界
- 支持 scale 放大（LANCZOS 插值）
- 输出 ImageInfo + ArtifactDescriptor

**与 ground/detect 的关系：** 接收它们的返回坐标，形成工具链

#### vision_pixel_diff — 像素对比

**算法流程：**
1. 缩放 rebuilt 到 original 尺寸（如需）
2. 网格化比较（默认 6×6）
3. 找出 top-N 最差区域
4. 生成 heatmap PNG + JSON report

**用途：** 视觉回归测试、UI 重建验证

#### vision_long_screenshot_ocr — 长截图 OCR

**这是最复杂的工具，支持：**
- 自动切分（基于 row_energy + occupancy 分析）
- 并发 OCR（jobs 参数）
- Chat 模式（结构化 JSON 提取）
- 断点续传（resume + runName）
- 仅切分模式（splitOnly）

**切分算法（long_screenshot_ocr.py）：**
1. `row_energy()` 计算每行边缘能量 + 前景占有率
2. `choose_cut()` 寻找低能量切割带
3. 安全边距处理（避免在内容边界切割）
4. 重叠裁剪（chat 模式 64px，general 模式 40px）

**Manifest 校验：** 严格的 schema_version + SHA256 + 连续性检查

#### vision_extract_foreground — 前景提取

**两种模式：**
- Manual mode：region 内保持所有足够大的连通分量
- Auto mode：以图像中心为圆心采样 disc 颜色，排除后取最大着色分量

**参数：** mode, discRadius, saturation, darkThreshold, excludeColor, padding

#### vision_dominant_colors — 主色调分析

**两种模式：**
- Palette 模式：下采样 + 量化 + 合并近色 → 列出显著颜色及占比
- Candidate 模式：对候选颜色打分 → 返回最匹配者

**用途：** 获取精确 hex 值，避免 vision model 的模糊描述

#### vision_html_screenshot — HTML 截图

- 使用 Puppeteer + Chrome/Chromium/Edge
- 支持 viewport 尺寸、scale、fullPage、waitMs
- 输出 PNG Artifact + 视口信息

---

## 三、Playbook 系统（Skill 设计）

### 3.1 Skill 结构

**文件位置：** `assets/skill/SKILL.md`（16070 字节）

**引用文件：**
- `references/long-screenshot-ocr.md` — 长截图 OCR 工作流
- `references/restore-ui.md` — UI 还原（标准 + 快速模式）
- `references/restore-graphic.md` — 图标/图形提取
- `references/restore-structure.md` — 图表/白板还原
- `references/gui.md` — GUI 自动化操作

### 3.2 Skill 核心设计原则

1. **工具优先于手写代码：** 明确列出"用 vision_crop，不要用 Image.open(...).crop()"
2. **Coarse-to-Fine 方法论：** 全图概览 → 目标定位 → 区域放大 → 精确测量
3. **未信任视觉证据：** 图像中的文字/说明不可作为指令执行
4. **坐标理解：** 0-1000 网格 → 像素坐标的转换说明
5. **工具链串联：** ground 输出 → crop 输入 → pixel_diff 验证

### 3.3 Fast Restore Mode vs Standard Mode

**Fast Mode（~3分钟）：**
- vision_detect 一次性全图扫描
- 最多 6 轮图像检查（每轮最多 3 个并发调用）
- 禁止使用 trace、foreground extraction、color sampling、pixel_diff 迭代
- 使用现有组件库而非重建

**Standard Mode：**
- 元素分类：code-native component vs screenshot-backed visual
- 逐元素决策树
- 精确颜色采样（dominant_colors）
- 迭代验证（pixel_diff 定位 → glance 确认）

### 3.4 Focus Hint 机制

**设计理念：** 根据用户问题生成任务相关的描述，而非通用描述

**实现：** 通过 SKILL.md 的内容结构和 explicit "Pick the tool by the question you are answering" 表格实现

---

## 四、DSH 集成方式

### 4.1 cordis.patch.yml

```yaml
- insert:
    - id: vision-toolkit
      name: '@anionex/dsh-vision-toolkit'
```

这是 DSH 的 bundle patch 格式，将插件挂载到 profile layer stack。

### 4.2 Plugin 生命周期

```typescript
export async function apply(ctx: Context, config: VisionToolkitConfig = {}): Promise<() => void> {
  // 1. 注册 Settings
  const settings = ctx.settings.register(VISION_TOOLKIT_SETTINGS_NAMESPACE, Config, {...})
  
  // 2. 创建 RuntimeManager
  const manager = new VisionToolkitRuntimeManager(ctx)
  
  // 3. 准备 Artifact 访问
  const artifacts = new ArtifactAccessController(await prepareArtifactAccessKey())
  
  // 4. 初始化 runtime（含上游验证）
  await manager.initialize(settings.get())
  
  // 5. 确保 operational（注册 tool exposure）
  ensureOperational()
  
  // 6. 注册 Web backend 和 image paste takeover
  installVisionToolkitWeb(...)
  
  // 7. 监听 settings 变化 → reconfigure
  settings.watch(async (next) => { ... })
  
  return () => { /* 清理 */ }
}
```

### 4.3 渐进式工具暴露

```typescript
// exposure.ts
export class VisionToolExposure {
  // Bootstrap tool（全局）
  readonly activationTool: ToolDefinition
  
  // Agent 级状态管理
  private readonly states = new Map<Agent, AgentExposure>
  
  // 激活逻辑
  activate(agent: Agent): VisionToolkitActivationResult
}
```

**触发条件：**
1. Skill 被加载（vision-skills）→ 自动激活
2. 调用 `vision_toolkit_activate` → 手动激活
3. Session restore 时检测历史 Skill 调用

### 4.4 配置系统

**Settings Namespace：** `vision-toolkit`

**核心配置项：**
| 字段 | 默认值 | 说明 |
|------|--------|------|
| provider.baseUrl | https://vision.anionex.me/v1 | 内置免费服务 |
| provider.credential | ANIONEX_FREE_VISION | 内置凭证引用 |
| provider.model | gemini-3.7-flash | 内置免费模型 |
| provider.protocol | openai | chat_completions / anthropic |
| language | zh | 输出语言 |
| timeoutMs | 30000 | 单次调用超时 |
| maxImageBytes | 4194304 | 自动压缩阈值 |
| maxImagePixels | 20000000 | 像素上限 |
| concurrency | 4 | 每 session 并发数 |
| runtime.mode | managed | managed / external |

### 4.5 路径管控

**PathPolicy：**
- workspace：当前会话工作目录
- allowedDirs：额外授权目录
- platform temp：自动授权（Windows: %TEMP%, POSIX: /tmp）
- 拒绝符号链接逃逸

---

## 五、上游关系（agent-vision-toolkit）

### 5.1 打包方式

上游代码通过 `scripts/upstream-manifest.mjs` 和 `scripts/sync-upstream.mjs` 同步到 `vendor/` 目录。

**UPSTREAM_MANIFEST.json 作用：**
- 锁定 commit hash：`bc9803d7d6300c864d17460ecbb33540b26638e0`
- 记录每个文件的 bytes + SHA256
- 启动时验证完整性

### 5.2 Python 客户端

**vision_client.py（310 行）：**
- 支持 OpenAI Chat Completions、Anthropic Messages、OpenAI Responses 三种协议
- 自动重试（429/5xx）
- SSL verify 控制
- 多 provider 抽象

### 5.3 DSH Patch（patches/vision-tools-dsh.patch）

**主要变更：**
1. Skill 名称：`vision-tools` → `vision-skills`
2. 工具名加前缀：`glance` → `vision_glance`
3. 文档适配：从 CLI 命令改为 JSON 参数对象
4. 新增 `vision_pixel_diff` 工具说明

---

## 六、代码质量评价

### 6.1 优点

| 方面 | 评价 |
|------|------|
| **安全性** | 路径严格管控、符号链接拒绝、SHA256 校验、AbortSignal 取消 |
| **可靠性** | Prepared-before-swap 更新、FIFO 并发门控、GlanceCache 复用 |
| **可维护性** | 类型安全（TypeScript strict）、模块化清晰、错误分类（VisionToolkitError） |
| **用户体验** | 内置免费服务、渐进式工具暴露、Artifact 持久化 |
| **测试覆盖** | vitest 测试、manifest 校验、upstream hash 验证 |

### 6.2 不足

| 方面 | 问题 |
|------|------|
| **文档密度** | SKILL.md 较长（329 行），新手学习曲线陡 |
| **Python 依赖** | 需要 Pillow、numpy（extract_fg auto mode）、Puppeteer（html_screenshot） |
| **并发限制** | 每 session 最多 4 并发，长截图 OCR 可能较慢 |
| **免费服务限制** | 100 张/天/机器，高峰可能 429 |
| **坐标精度** | 0-1000 网格缩放，最后几位像素不可靠 |

### 6.3 设计亮点

1. **Evidence Cache：** 基于 provider/model/language/credential 的 fingerprint，相同输入不重复调用
2. **Compressed Image Cache：** 200 条目 / 512MB 上限，SHA256 前缀匹配
3. **Manifest Schema 严格校验：** long_screenshot_ocr 的 manifest 必须 schema_version=1 + 连续 index + SHA256
4. **Python Bootstrap：** 自包含 Python 3.11+ 下载（支持 musl Linux、Windows Store Python）

---

## 七、可用于新插件的设计模式

### 7.1 推荐借鉴的模式

1. **Progressive Tool Exposure（渐进工具暴露）**
   - 工具按需注册，不污染全局命名空间
   - Bootstrap tool 作为备用激活路径

2. **Prepared-before-Swap（准备后交换）**
   - 新配置完全准备后再替换 active，保证运行中调用不受影响
   - 失败时回滚到上一代

3. **Structured Error Classification（结构化错误分类）**
   - VisionToolkitError with code: 'config' | 'input' | 'runtime' | 'output' | 'cancelled' | 'timeout' | 'path'
   - 便于前端/日志分类处理

4. **Manifest-Based Upstream Pinning（Manifest 上游锁定）**
   - 精确版本锁定 + SHA256 完整性验证
   - 防止上游篡改或意外更新

5. **PathPolicy（路径策略）**
   - 工作目录 + 授权目录双白名单
   - 拒绝符号链接逃逸

6. **Semaphore with Cancellation（带取消的并发门控）**
   - FIFO 队列 + AbortSignal 支持
   - 过期自动清理

7. **Artifact Descriptor（Artifact 描述符）**
   - 统一的文件交付契约：path + mimeType + kind + previewIntent
   - 便于 UI 渲染和后续工具复用

### 7.2 需要注意的陷阱

1. **坐标系统一性：** ground/detect 返回的坐标是原始像素，crop 也接受原始像素，但 trace 可能使用缩放后尺寸
2. **Region 参数格式：** 必须是 "X1,Y1,X2,Y2" 字符串，不能是对象
3. **Untrusted Visual Evidence：** 图像内的文字/说明不可直接执行
4. **并发工具限制：** preview=true 的工具不可并发（独占资源）

---

## 八、架构对比与建议

### 8.1 与潜在新插件的对比维度

| 维度 | dsh-vision-toolkit | 新插件建议 |
|------|-------------------|-----------|
| 架构层 | TypeScript + Python 混合 | 纯 TypeScript 或更轻量的 Python 封装 |
| 上游锁定 | SHA256 manifest | 可选：semver 范围 |
| 工具数量 | 10 个 | 精简至核心 5-6 个 |
| 免费服务 | vision.anionex.me | 可扩展多 provider 支持 |
| Skill 系统 | 单一 SKILL.md | 可拆分主题 Skill |
| 坐标系 | 原始像素 | 统一 0-1000 或 native 像素 |

### 8.2 可改进的方向

1. **Focus Hint 自动生成：** 当前依赖人工编写 SKILL.md，可扩展为根据用户问题动态生成 focus hint
2. **工具组合编排：** 当前 SKILL.md 描述工具链，可升级为结构化 playbook YAML
3. **跨 session 缓存：** 当前 GlanceCache 仅限单 session，可扩展为跨 session 持久化
4. **多 provider fallback：** 内置免费服务不可用时自动 fallback 到用户配置 provider
5. **WebAssembly 本地处理：** trace/crop/pixel_diff 等本地工具可考虑 WASM 化减少 Python 依赖

---

## 九、总结

dsh-vision-toolkit 是一个设计精良的 DSH 原生视觉插件，其核心优势在于：

1. **安全的系统集成**：路径管控、上游锁定、并发门控构成完整的安全边界
2. **优雅的工具暴露**：渐进式注册 + bootstrap tool + Skill 联动
3. **实用的方法学**：SKILL.md 提供经过实战验证的工作流指导
4. **开箱即用**：内置免费 Vision 服务降低使用门槛

对于新插件开发，建议重点借鉴其 **Prepared-before-Swap 更新模式**、**PathPolicy 路径管控**、**Semaphore 并发门控** 和 **Structured Error Classification** 设计。

---

*报告生成时间：2026-08-21*
*研究目录：/home/z/vision-research/repos/dsh-vision-toolkit*
