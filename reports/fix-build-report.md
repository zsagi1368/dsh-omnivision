# DSH-Omnivision 构建管线修复报告

## 修复摘要

| 项目 | 状态 | 详情 |
|------|------|------|
| typecheck | ✅ | `tsc --noEmit` 通过 |
| lint | ✅ | `biome check src` 通过，15 个文件检查无错误 |
| build | ✅ | Vite SSR 构建成功，输出 `dist/index.js` (24.36 kB) |

---

## 修复内容

### 1. vite.config.ts — SSR 打包修复

**问题**: 使用 `lib` 模式构建 Node.js 插件，导致 `node:crypto`、`node:fs` 等内置模块被当作浏览器依赖报错。

**修复**:
- 移除 `lib` 模式，改用 `ssr: true` + `target: 'node22'`
- 将 `node:*` 内置模块和运行时依赖加入 `external`
- 修复 `rollupOptions.output.sourcemap` 为 `build.sourcemap: true`
- 输出格式改为 ESM

### 2. biome.json — 配置迁移

**问题**: 使用了 Biome 2.x 已移除的键：
- `organizeImports.enabled` → 已移除
- `files.ignore` → 改为 `files.ignoreUnknown`

**修复**: 迁移到 Biome 2.x 新配置格式，保留 formatter/linter 基本配置。

### 3. package.json — 悬空引用修复

**问题清单**:
| 问题 | 修复 |
|------|------|
| `bin` 指向不存在的 `dist/cli.js` | 移除 `bin` 字段 |
| `files` 引用 `README.zh.md` 不存在 | 改为 `README.zh-CN.md`（实际文件名） |
| `scripts.release.mjs` 不存在 | 移除 `release` 脚本 |
| `schemastery` 是死依赖 | 从 `dependencies` 移除 |
| `lint/format` 检查不存在的 `lib/` 目录 | 改为只检查 `src/` |
| `@deepseek-ai/schemastery` 从 deps 移到 peerDeps | 与实际使用一致 |

### 4. 补充缺失文件

**创建 `src/tools/index.ts`**:
- 原 `src/tools/types.ts` 中的 TOOLS 数组引用了不存在的 `./index.ts`
- 创建了 stub 实现文件，包含所有工具函数的占位实现

**创建 `LICENSE`**:
- package.json 中 license 字段为 MIT，但缺少对应文件
- 添加了标准 MIT License 文本

---

## 代码质量修复

| 文件 | 修复内容 |
|------|---------|
| `src/security/index.ts` | 移除未使用的 `existsSync` 导入 |
| `src/vision/chain.ts` | 移除重复的 `VisionCircuitBreaker` 类型导入 |
| `src/vision/provider.ts` | 移除未使用的 `ImageSource` 类型导入；`_name` 参数加下划线前缀 |
| `src/utils/image.ts` | 修正 import 排序 (access, readFile) |
| `src/bridge/message-rewriter.ts` | 修复 `noAssignInExpressions`（while 循环赋值） |
| `src/bridge/vision-bridge.ts` | 移除 `ImageSource` 中不存在的 `bytes` 字段 |
| `src/plugin/index.ts` | 修复 `any` 类型，改为类型守卫检查 |
| `src/tools/types.ts` | 移除未使用的 `visionPixelDiff` 变量；修复未使用参数 |

---

## 最终构建产物

```
dist/
├── index.js      (24.36 kB)
└── index.js.map  (51.42 kB)
```

所有 Node.js 内置模块（`node:crypto`, `node:fs`, `node:path`, `node:dns`）均作为 external 处理，符合 SSR 打包要求。
