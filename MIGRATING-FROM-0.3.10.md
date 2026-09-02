# 从 AtomOS Desktop 0.3.10 迁移 Artifact

本文说明如何将为 AtomOS Desktop 0.3.10 编写的 HTML Artifact 更新到新版 Artifact SDK。迁移后的 Artifact 应只使用新版 Host API、显式声明所需能力，并通过新版 AtomOS Desktop 实际打开验证。

## 迁移速览

- [ ] 将所有 `window.opencode*` Host API 改为 `window.atomos.*`。
- [ ] 不保留旧 namespace 的兼容层，也不在 Artifact 内自行创建 alias。
- [ ] 检查 `artifact.json` 的 `id`、`entry`、`routing` 和 `capabilities`。
- [ ] 需要打开参数或 Files 文件关联时，将 Manifest 升级到 version 2 并添加 `open.inputSchema`。
- [ ] 需要从 Files 直接打开文件时，将唯一的 `workspace-file` 输入设为必填，并在 `accept` 中声明点前缀后缀，例如 `.pdf`。
- [ ] 将运行数据写入 Workspace 的 `.atomos/artifact-data/`，不要写入 Artifact definition 目录。
- [ ] 将第三方脚本、样式、字体、Worker、WASM 等静态依赖放在 Artifact 目录内。
- [ ] 保存并释放 operation、Workspace subscription 和 Agent receive 的 disposer。
- [ ] 在新版打包 Desktop 中验证，不要只在普通浏览器中打开 HTML。

## 1. 更新 Host API namespace

新版不再注入 0.3.10 使用的独立 `window.opencode*` 全局对象。所有 Host API 统一放在 `window.atomos` 下。

| 0.3.10 | 新版 |
| --- | --- |
| `window.opencodeWorkspace` | `window.atomos.workspace` |
| `window.opencodeArtifact` | `window.atomos.artifact` |
| `window.opencodeAgent` | `window.atomos.agent` |
| `window.opencodeConversation` | `window.atomos.conversation` |
| `window.opencodeServices` | `window.atomos.services` |
| `window.opencodeHttp` | `window.atomos.http` |
| `window.opencodeShell` | `window.atomos.shell` |

多数 Workspace、Artifact、Agent 和 conversation 调用可以直接替换前缀；Services discovery 和推荐的 object form 需要按后文单独核对。

### 迁移前

```js
const inputs = await window.opencodeArtifact.getOpenInputs()
const text = await window.opencodeWorkspace.readText(inputs.document.path)

await window.opencodeArtifact.setTitle("Document Review")
await window.opencodeConversation.addReference({
  idempotencyKey: crypto.randomUUID(),
  label: "Selected text",
  text,
})
```

### 迁移后

```js
const inputs = await window.atomos.artifact.getOpenInputs()
const text = await window.atomos.workspace.readText(inputs.document.path)

await window.atomos.artifact.setTitle("Document Review")
await window.atomos.conversation.addReference({
  idempotencyKey: crypto.randomUUID(),
  label: "Selected text",
  text,
})
```

不要添加下面这样的兼容代码：

```js
// 不要这样做：旧 namespace 已不是新版合同的一部分。
window.opencodeWorkspace = window.atomos.workspace
```

> 注意：Manifest 中的扩展关键字仍然叫作 `"x-opencode-kind": "workspace-file"`。不要把它改成 `x-atomos-kind`。

## 2. 检查并升级 `artifact.json`

新版仍接受 Manifest version 1，但 version 1 没有 `open.inputSchema`，不能接收结构化打开参数，也不能参与 Files 后缀自动打开。

- Artifact 只需要静态入口且不接收打开参数时，可以继续使用 version 1，但 JavaScript 仍必须迁移到 `window.atomos.*`。
- Artifact 需要接收文件或其他打开参数时，使用 version 2。
- 不要依赖缺少 `artifact.json` 时的临时宽权限兼容行为。

Workspace Artifact 应作为 `<workspace-directory>/artifacts/<artifact-name>/` 的直接子目录；默认位置是 `.atomos/artifacts/<artifact-name>/`。`artifact.json` 与入口文件放在同一目录，必须是小于 64 KiB 的普通 JSON 文件，`entry` 指向真实 `.html` 或 `.htm` 文件。

### 完整 version 2 PDF Artifact 示例

```json
{
  "version": 2,
  "id": "pdf-review",
  "name": "PDF Review",
  "description": "Review a PDF from the current Workspace.",
  "entry": "index.html",
  "routing": "spa",
  "open": {
    "inputSchema": {
      "type": "object",
      "properties": {
        "document": {
          "type": "object",
          "x-opencode-kind": "workspace-file",
          "accept": ["application/pdf", ".pdf"]
        }
      },
      "required": ["document"],
      "additionalProperties": false
    }
  },
  "capabilities": {
    "workspace": {
      "read": [".atomos/artifact-data/workspace/pdf-review/**"],
      "write": [".atomos/artifact-data/workspace/pdf-review/**"]
    },
    "agent": {
      "compose": false,
      "send": false,
      "receive": false
    },
    "network": false
  },
  "home": {
    "quickAccess": true
  },
  "data": {
    "schemaVersion": 1
  },
  "services": []
}
```

打开后读取输入：

```js
const inputs = await window.atomos.artifact.getOpenInputs()
const path = inputs?.document?.path

if (!path) throw new Error("A PDF document is required.")

const bytes = await window.atomos.workspace.readBinary(path)
```

`workspace-file` 的值是 Workspace 相对路径对象 `{ path: string }`，不是浏览器 `File`、Blob、URL、base64 或绝对路径。Host 会在当前 Artifact instance 生命周期内为该文件提供精确的只读授权。

### Manifest v2 Schema 边界

- 根节点必须是 object。
- object 使用 `properties`；存在 `additionalProperties` 时必须为 `false`。
- string 必须设置 `maxLength`。
- array 必须设置 `items` 和 `maxItems`。
- 不支持 `$ref` 或未声明的 Schema 关键字。
- Workspace 路径和权限 glob 都相对于 Workspace root，不是相对于 Artifact HTML。
- `id` 应保持稳定；修改展示名称时不要修改 `id`。
- `entry` 必须精确指向真实入口文件。
- `routing` 使用 `spa` 或 `files`。

## 3. 让 Files 中的文件直接打开 Artifact

新版复用 Manifest v2 的 `workspace-file.accept` 作为文件关联声明，不增加 `extensions`、`fileAssociations` 或 MIME 优先级字段。

要让 Files 中的 PDF 直接打开 Artifact，必须同时满足：

1. 根 `open.inputSchema` 恰好只有一个 required property。
2. 该 required property 是匹配文件后缀的 `workspace-file`。
3. 可以存在 optional sibling properties，但不能有其他 required property。
4. `accept` 中包含显式点前缀后缀，例如 `.pdf`。

MIME 或 wildcard 仍可用于输入校验，但不会创建 Files 文件关联。例如只有 `application/pdf` 而没有 `.pdf` 时，Artifact 不会成为 PDF 点击候选。

后缀匹配不区分大小写。首版使用单后缀语义：`report.PDF` 匹配 `.pdf`；`archive.tar.gz` 按 `.gz` 处理，不要依赖 `.tar.gz` 建立关联。

关联由 Host 管理：

- 唯一候选会直接打开。
- 多个 Artifact 接受同一后缀时，Host 显示 chooser。
- 用户选择后，Host 按当前 Workspace 保存 `后缀 → {scope, id}` 绑定。
- 切换 Workspace 不会继承另一个 Workspace 的绑定。
- 绑定失效时，Host 会重新选择候选或回退普通 Viewer。
- Artifact 不应把用户绑定写入 Manifest 或自己的运行数据。

本仓库可参考：

- [PDF Reader Manifest](.atomos/artifacts/pdf-reader/artifact.json)
- [Dataset Explorer Manifest](.atomos/artifacts/dataset-explorer/artifact.json)
- [Molecule Manifest](.atomos/artifacts/molecule/artifact.json)

## 4. 收紧能力与持久化边界

Manifest 只声明 Artifact 实际需要的最小能力。

### Workspace

```json
{
  "capabilities": {
    "workspace": {
      "read": ["reports/**", ".atomos/artifact-data/workspace/report-viewer/**"],
      "write": [".atomos/artifact-data/workspace/report-viewer/**"]
    }
  }
}
```

- `read` 和 `write` 是 Workspace 相对 glob。
- 不要使用绝对路径或 `..`。
- 不要把运行数据写入 `.atomos/artifacts/<artifact>/` definition 目录。
- 显式文件格式或非 JSON 数据使用 `window.atomos.workspace.*`。
- 小型 JSON 状态可使用 `window.atomos.artifact.load/save`。

```js
await window.atomos.artifact.save("state.json", { selected: [1, 2, 3] })
const state = await window.atomos.artifact.load("state.json")
```

Workspace Artifact 的状态应位于：

```text
.atomos/artifact-data/workspace/<artifact-id>/
```

Bundled 和 User definition 的运行数据同样写入当前 Workspace，只是 scope 段分别为 `bundled` 和 `user`。默认配置下的通式为 `<workspace-root>/.atomos/artifact-data/<scope>/<id>/`。

### Agent 与 conversation

```json
{
  "capabilities": {
    "agent": {
      "compose": true,
      "send": "confirm",
      "receive": true
    }
  }
}
```

- `agent.compose` 只准备 Composer 内容，不自动发送。
- `agent.send` 建议显式设置 `visibility: "explicit"` 或 `"implicit"`。
- `silence: true` 与 visibility 相互独立，并且只有全局 Artifact 设置也允许静默发送时才生效。
- `conversation.addReference` 应由 Artifact 自己的 “Add to conversation” 交互触发；不要自动捕获用户选择。

```js
await window.atomos.agent.compose({
  text: "Review this report.",
  files: [{ path: ".atomos/artifact-data/workspace/report-viewer/report.json" }],
})

await window.atomos.conversation.addReference({
  idempotencyKey: crypto.randomUUID(),
  label: "Report selection",
  text: "Selected content",
  location: "Report / Summary",
})
```

需要直接发送时，使用显式 delivery contract：

```js
const admitted = await window.atomos.agent.send({
  text: "Analyze the prepared report.",
  files: [{ path: ".atomos/artifact-data/workspace/report-viewer/report.json" }],
  idempotencyKey: crypto.randomUUID(),
  visibility: "explicit",
  silence: false,
})
```

- Manifest 中 `capabilities.agent.send` 只能是 `false` 或 `"confirm"`。
- Promise resolve 表示请求已被接收并唤醒 Session，不表示模型已经完成。
- Send 没有 response stream、状态查询或取消 API；异步结果应通过 Workspace 文件交换。
- 对结果不确定的超时不要自动换一个新 idempotency key 重试，否则可能产生重复请求。

### Extension Services

在 Manifest 顶层用完整 operation ID 声明授权：

```json
{
  "services": ["protein-canvas.sketch.save"]
}
```

先使用 `list()` / `describe()` 查询当前能力快照，再使用 object form 调用 `invoke()` 或 `read()`：

```js
const services = await window.atomos.services.list()

const result = await window.atomos.services.invoke({
  service: "protein-canvas",
  action: "sketch.save",
  input: { name: "example" },
})
```

- `list()` / `describe()` 只暴露 Manifest `services` 中精确声明并授权的 operation。
- 查询只返回当前快照，不授予权限，也不订阅后续变化。
- 已授权但暂不可用的 operation 会返回 `available: false`。
- 不要依赖点号 operation ID 的字符串简写，也不要认为 Manifest 授权意味着 Extension 或 operation 当前一定可用。

### HTTP 与 Shell

- 外部、localhost、LAN 或远端 Server HTTP 请求使用 `window.atomos.http.request`，不要使用浏览器 `fetch`。
- HTTP 还需要 Manifest network 能力和用户设置允许。
- Shell 使用 `window.atomos.shell.run`，由用户的 Artifact Shell 设置控制。
- Shell 没有 Manifest grant，也没有逐请求确认；不要添加不存在的 `capabilities.shell`。
- Shell 始终在当前 Workspace 运行，不提供 PTY、stdin、环境变量覆盖、后台模式或替代 workdir。

```js
const response = await window.atomos.http.request({
  url: "https://example.com/data.json",
  method: "GET",
})

const result = await window.atomos.shell.run({
  command: "git status --short",
  timeout: 30_000,
})
```

## 5. 使用 canonical 参数形式

部分旧简写仍可能被接受，但新代码应使用 object form，避免后续歧义。

```js
const chunk = await window.atomos.workspace.readRange(path, {
  offset: 0,
  length: 8 * 1024 * 1024,
})

const matches = await window.atomos.workspace.search({
  path: "reports",
  query: "ready",
  glob: "**/*.json",
  caseSensitive: false,
  maxResults: 100,
  maxFileBytes: 1024 * 1024,
})
```

## 6. 正确处理 instance 生命周期

使用新的 `idempotencyKey` 成功打开会创建独立的 Artifact instance。即使多个 tab 使用同一个 definition，它们的 open inputs、标题、ready 状态和 operations 也互相独立。

同一 Session 中，相同 key 与相同请求是精确重试，会返回原 instance；相同 key 与不同 ref、path、viewer 或 inputs 会被拒绝。

保存 `exposeOperations` 返回的 disposer：

```js
const disposeOperations = window.atomos.artifact.exposeOperations({
  refresh: {
    description: "Refresh the current report",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    run: async () => {
      await refresh()
      return { refreshed: true }
    },
  },
})

window.addEventListener("unload", () => disposeOperations(), { once: true })
```

同样需要释放 Workspace subscription 或 Agent receive handler：

```js
const disposeWorkspace = await window.atomos.workspace.onDidChange(
  ["reports/**/*.json"],
  () => {
    void reloadCurrentState()
  },
)

window.addEventListener("unload", () => disposeWorkspace(), { once: true })
```

不要复用旧 document 的请求、disposer 或 operation handler。reload、close、reopen 或切换 Workspace 后，旧 Artifact Site Session 会失效。

## 7. 静态资源与浏览器边界

- 将 JavaScript、CSS、图片、字体、动态 import、Worker 和 WASM 放在 Artifact 目录内。
- 不要从 CDN 加载依赖；Artifact Site CSP 不提供任意远端脚本或样式访问。
- 不要访问 Host DOM、`window.parent` 内部、Host storage、浏览器凭据、环境变量或 Node API。
- 不要创建自定义监听端口或 Artifact 专用后端。
- Blob URL 使用完毕后由 Artifact 自己 revoke。

## 8. 错误处理

Host API 返回 Promise。错误可能包含 `message`、`code` 和 `data`：

```js
try {
  const text = await window.atomos.workspace.readText("reports/result.json")
} catch (error) {
  console.error(error.message, error.code, error.data)
  showError(error.message || "Request failed")
}
```

有 `code` 时优先按 `code` 处理，不要依赖解析错误文案。

## 9. 迁移后验证

### 静态检查

确认旧 Host 全局已经清零：

```sh
rg --hidden -n 'window\.opencode(Workspace|Artifact|Agent|Conversation|Services|Http|Shell)' \
  .atomos/artifacts/<artifact-directory>
```

命令应无输出。

验证 Manifest JSON 语法：

```sh
jq empty .atomos/artifacts/<artifact-directory>/artifact.json
```

`jq empty` 不验证 Manifest Schema、名称冲突或 ID 冲突。真正的 definition 验证应在新版 Host 中检查 `list_artifact_definitions` / `describe_artifact` 返回的 `validation.status`，并处理 `invalid`、`name_conflict` 和 `id_conflict`。

### 新版 Desktop 验证

1. 在新版 AtomOS Desktop 中发现并打开 definition。
2. 不要以普通浏览器直接打开 HTML 作为验收结论。
3. 使用真实输入验证 loading、empty、success、permission denied、invalid input 和 unavailable Host 状态。
4. 验证所有声明的 Workspace read/write、Agent、Service、HTTP 或 Shell 能力。
5. 若有文件输入，从 Files 点击真实文件：
   - 唯一候选应直接打开。
   - 多候选应显示 chooser。
   - 选择后，同 Workspace 应复用绑定。
   - 切换 Workspace 不应继承绑定。
   - definition 失效时应回退 Viewer 或重新选择。
6. 用不同 idempotency key 打开同一 definition 两次，确认 instance、inputs、标题和 operations 隔离；再用相同 key 精确重试，确认返回原 instance，并验证冲突复用会被拒绝。
7. 验证 reload、close/reopen 和 Workspace 切换后旧请求失效，持久数据仍留在正确 Workspace。
8. 确认所有相对资源、Worker、WASM 和动态 import 均能在 Artifact Site CSP 下加载。

如果可以使用 Agent Artifact 工具，还应通过 `list_artifact_definitions`、`describe_artifact` 和 `open_artifact` 验证真实 Host 合同，而不是只检查页面外观。

## 10. 本仓库中的迁移示例

- [Dataset Explorer](.atomos/artifacts/dataset-explorer/)：Workspace CSV/TSV 输入、operations 和 conversation reference。
- [Molecule](.atomos/artifacts/molecule/)：大文件分段读取、Mol* 本地资源、动态 operations 和 state。
- [PDF Reader](.atomos/artifacts/pdf-reader/)：PDF 文件输入、Files 后缀关联、二进制读取和 conversation reference。
- [Robot Lab](.atomos/artifacts/robot-lab/)：动态状态与 Agent-callable operations。
- [Shell Test](.atomos/artifacts/shell-test/)：受设置控制的 bounded foreground Shell 调用。

迁移时应按 Artifact 实际使用的能力选择示例，不要直接复制不需要的权限。
