# dsh-connect-officeace

让 DSH 直接复用本机 **OfficeAce** 已经登录的华为 MaaS 模型通道，把 OfficeAce
内置的模型变成 DSH 里的一个 provider（路由 id：`officeace`），并在输入框工具栏
显示该账号的**积分余额**。

这是 `dsh-connect-trae` / `dsh-qoder-connect` 的同族插件：三者都复用另一个桌面应用
已经持有的模型凭据，不改动 DSH profile 的默认模型，只新增一个可选 provider。

---

## 与 Trae / Qoder 插件的关键差异

| | Trae | Qoder | **OfficeAce（本插件）** |
|---|---|---|---|
| 上游协议 | 私有 `Cloud-IDE-JWT` + 自定义 SSE | 私有 COSY RSA/AES/MD5 签名 + 自定义 SSE | **标准 OpenAI 兼容** |
| 是否需要 127.0.0.1 回环 shim | 需要 | 需要 | **不需要** |
| 是否需要 `@earendil-works/pi-ai` | 需要（`PiAiAdapter`） | 需要（`PiAiAdapter`） | **不需要** |
| 凭据来源 | `storage.json`（自研解密） | 自管 `settings.json` + PAT | **OfficeAce `storage.sqlite` 会话表（1.3.4+），DPAPI profile 为旧版回退** |
| 实现方式 | 私有协议 → shim → pi-ai | 私有协议 → shim → pi-ai | **手写 `LlmAdapter` + 直接 `fetch`** |
| 积分余额 | 输入框工具栏读数 + 账号浮层 | — | **输入框工具栏读数 + 分组明细浮层** |

Trae 与 Qoder 之所以要起回环 shim，是因为它们的上游是私有协议，必须翻译成 OpenAI
协议后才能交给 `dsh-llm-pi-ai`。OfficeAce 的网关本身就是 OpenAI 兼容的
（`POST {baseUrl}/chat/completions`），所以本插件直接手写 `LlmAdapter`，
少一层进程、少一层序列化、也少一份依赖。

---

## 凭据是怎么拿到的

本插件只读取 OfficeAce 的凭据，不修改、不上传。凭据链有两条，按优先级尝试：

### 主链路：SQLite 会话表（OfficeAce 1.3.4+）

1. `~/.office-claw/connector-owner.local.json` → `ownerUserId`，确定当前账号。
2. `%LOCALAPPDATA%\Programs\OfficeAce\data\storage.sqlite` → 只读打开，执行
   ```sql
   SELECT key, value FROM oc_kv_string
   WHERE key LIKE 'office-claw:oc:session:user:%'
   ```
   优先取 key 正好等于 `office-claw:oc:session:user:<ownerUserId>` 的那一行；
   取不到时退而取唯一一行。
3. 解析该行的 JSON，从 `providerState.modelInfo.model_auth_info` 取
   `{model_app_key, model_app_secret}`，从 `modelInfo.model_api_url_base`
   取网关地址，拼成 `Authorization: Basic base64(appKey:appSecret)`。

> 1.3.4 起 OfficeAce 把登录会话迁到了这个 SQLite KV 表，旧版的
> `--mode dpapi-unprotect` 子命令**已从 `OfficeAceServiceHost.exe` 移除**，
> 所以旧链路不再可用。

### 回退链路：DPAPI + AES-256-GCM profile（OfficeAce ≤1.3.3）

1. `packages\api\.config\secure-config-nodejs\.oauth-profile-encryption-key`
   是 DPAPI 保护（`OC-DPAPI-1\n` 前缀）的 blob，通过 `OfficeAceServiceHost.exe
   --mode dpapi-unprotect`（stdin/stdout 走 base64）解出 install secret。
2. `oauth-<urlencode(userId)>.json` 是 `aes-256-gcm` 密文，密钥为
   `sha256(installSecret)`，`iv`/`tag` 为 base64url。

只有当主链路不可用（无 `storage.sqlite`、`node:sqlite` 缺失、或表里没有会话）时，
才会走这条回退链路。

### 设计上的两个要点

- **每次请求都重新解析凭据**，不长期缓存。OfficeAce 会在会话续期/密钥轮换后改写
  存储，按 mtime 失效的缓存即可自愈。
- **插件自己无法刷新登录**。OfficeAce 会话过期（实测 TTL 约 100 分钟）后，
  需要用户重新打开 OfficeAce 完成续期，插件侧的请求会以 `INVALID_CREDENTIAL`
  失败并给出提示。

> 注意：本插件借用的是用户本机 OfficeAce 自己的账号凭据，不是官方开放 API。
> 调用会消耗该账号的 OfficeAce / 华为 MaaS 配额。

---

## 积分余额

输入框工具栏（「专家」与模型选择器之间）会显示 `OfficeAce · <剩余积分>`，
**只在当前会话选中的模型属于本插件时出现**。整块可点击，弹出浮层展示：

- 当前套餐与剩余/总计积分
- 各积分组的明细（套餐、新用户福利、每日签到……），含各自的剩余/总计与到期时间
- 手动刷新按钮

每 5 分钟自动刷新，也可以点浮层里的「刷新」立即读一次。

### 数据从哪来

OfficeAce 的**模型网关不提供余额接口**（实测 30 余个候选路径全部返回
`404 APIG.0101`）。积分数据在另一侧：OfficeAce 桌面应用在自己机器上起了一个
本地 API（`https://127.0.0.1:3004`，自签证书），它的 Web UI 通过
`GET /api/subscription/current` 读订阅与积分。

该端点要求三个自定义头，取值全部来自 OfficeAce 自己的会话记录
（`storage.sqlite` 的 `oc_kv_string` 表，与模型凭据**同一份记录**）：

```
X-Office-Claw-User:    <userId>
Authorization:         Bearer <sessionId>
X-Office-Claw-Session: <sessionId>
```

因此本插件复用同一份身份去读这个只读端点——与复用模型凭据是同一个边界
（不防同用户进程）。**整个链路只发 GET，没有任何写操作。**

### 两个必须知道的限制

1. **OfficeAce 必须正在运行。** 本地 API 随应用启动/退出。它没运行时读数
   整块不显示，DSH 照常能用 `officeace` 模型（模型走外网网关，与本地 API 无关）。
2. **读数走 HTTPS + 自签证书。** 签发它的根 CA 不在 Windows 信任库里，所以
   插件用 `node:https` 的 per-request `ca` 选项显式信任
   `<install>/.office-claw/certs/root-ca.pem`，**而不是**设
   `NODE_TLS_REJECT_UNAUTHORIZED=0`——那会削弱 DSH 进程里所有 TLS 连接。

### 读数口径

浮层与读数显示的**顶层汇总**（`totalCredits - usedCredits`），与 OfficeAce
自己的订阅卡片对得上。分组明细按上游顺序原样列出（含已过期的，加删除线），
因为「为什么余额比昨天少」的答案就在过期行里。

分组之和不等于汇总是**正常的**：实测本机三个分组的 remaining 之和是
`500 + 4000 + 675.18 = 5175.18`，而汇总 remaining 是 `6175.18` —— 差的那 1000
是 `bonusSkus` 里的「国庆黄金周·登录翻倍礼」，它没有出现在 `creditGroups` 里。
分组是会漏的，所以不做分组求和。

---

## 暴露的模型

OfficeAce 网关的 `/models` 广告 28 个模型，实测**只有 9 个真正可调用**。其余 19 个
分别返回 404 `ModelArts.81009 Invalid model`、403 无权限、或 400。本插件只暴露这 9 个：

| 模型 id | 上下文窗口 | 支持的 `reasoning_effort` |
|---|---|---|
| `deepseek-v4.1-flash` | 1048576 | none, low, medium, high, xhigh, max |
| `deepseek-v4.1-flash-0930` | 1048576 | none, low, medium, high, xhigh, max |
| `deepseek-v4-flash` | 1044480 | low, medium, high, xhigh, max |
| `deepseek-v4-flash-0731` | 1048576 | none, low, medium, high, xhigh, max |
| `glm-5.1` | 196608 | low, medium, high, xhigh, max |
| `glm-5.2` | 1044480 | none, minimal, low, medium, high, xhigh, max |
| `glm-5.3` | 1044480 | low, high, max |
| `Kimi-K2.6` | 262144 | low, medium, high, xhigh, max |
| `kimi-k2.6` | 262144 | low, medium, high, xhigh, max |

上表全部是**实测值**，不是抄文档：

- `contextWindow` 来自网关在 prompt 超限时回显的
  `Prompt length exceeds: the prompt length N must less than the maximum input length M`
  以及 `input token limit is 1048576`。
- `reasoning_effort` 取值集合来自发送非法 effort 后网关回显的合法集合
  （`reasoning_effort must be [none, minimal, low, ...] for glm-5.2`）。

> 顺带一个反例：OfficeAce 自己的 `chunk-4EE7TKOF.js` 里有一张上下文表，把
> `glm-5.2` 写成 `196608`，但网关实测接受了 555566 token 并只在 1044480 处拒绝。
> 所以本插件以**实测值**为准，不采信那张表。

能力边界：

- ✅ 流式对话、非流式、function calling（含多轮 `tool_call_id` 往返）、中段 system 消息
- ✅ 所有 9 个模型都会返回 `reasoning_content`（映射为 DSH 的 `reasoning` 块）
- ❌ **不支持图片输入**：网关对 `image_url` 返回
  `has unsupported content type: 'image_url', only supported type(s): 'text'.`
  因此 `resolveModel` 声明 `inputModalities: ['text']`，让 DSH 把图片替换成文本占位符，
  而不是发出去吃 400
- ❌ 不支持 `developer` role：网关 role 白名单是
  `['system','assistant','function','user','tool']`，所以适配器把 developer 降级为 system
- ✅ 原生接受 `role: "tool"` + `tool_call_id`，因此**不**把 tool 重写成 user

---

## 安装

**必须从打包好的 `.tgz` 安装，不要直接安装源码目录。**

```powershell
# 1) 打包（生成 dist/dsh-connect-officeace-<version>.tgz）
node scripts/pack.mjs

# 2) 用 DSH 的 plugin_manager 安装
#    action: install_bundle
#    target: D:/document/dsh/dsh-connect-officeace/dist/dsh-connect-officeace-0.3.0.tgz
```

为什么不能安装目录：`install_bundle` 对本地**目录**会写成 `link:` 依赖，pnpm 生成
junction，插件的真实路径落在 profile 树之外。DSH 的模块解析层会把该包归类为
linked layer，并且**在宿主进程启动时就把裸包名 `dsh-connect-officeace` 的解析结果
钉死到源码目录**（`createRuntimeResolution` 每次启动只算一次）。此后从源码目录
加载 `lib/index.js` 时，`@deepseek-ai/schemastery` 等 dsh 自带裸包名解析失败，
模块求值 reject → 无 fiber → 只报一句不透明的 `failed to import`。

从 `.tgz` 安装时 pnpm 在 profile 的 `node_modules` 下建**真实目录**，与 Trae/Qoder
一致，裸包名即可正常解析。

> 若之前用目录装过，profile 里会残留 `link:` 记录，而**已运行的宿主进程仍持有旧的
> 解析结果**。这种情况下需要重启 DSH 桌面应用让解析重新计算；光重新安装 `.tgz`
> 不足以在当前进程内生效。

安装后 DSH 会新增一个 provider 路由 `officeace`，**不会**改动 profile 的默认模型。
想用它时，在 DSH 里把模型切到 `officeace` 下的任一模型即可。切过去之后，输入框
工具栏就会出现积分读数。

## 文件结构

```
dsh-connect-officeace/
├── lib/
│   ├── index.js          宿主半边：provider 注册 + 积分读数路由
│   ├── credentials.js    凭据解析（SQLite 会话 / DPAPI 回退）+ 会话身份
│   ├── credits.js        本地 API 只读客户端 + 积分文档归一化
│   └── client.js         浏览器半边：输入框工具栏积分读数
├── cordis.patch.yml      声明插入到 DSH profile
├── scripts/pack.mjs      打包为可安装的 .tgz
└── package.json          dsh.bundle.patch / dsh.client.inject / peerDeps
```

## 配置项

| 字段 | 说明 |
|---|---|
| `installRoot` | OfficeAce 安装根目录，留空自动探测 |
| `profileFile` | 可选，旧版（≤1.3.3）直接指定 `oauth-<userId>.json` 路径；1.3.4+ 用不到 |
| `enabledModelIds` | 启用的模型 id 白名单，留空 = 全部 9 个 |
| `contextBudgets` | 按模型 id 覆盖上下文窗口 |

`installRoot` / `profileFile` / `enabledModelIds` 为 volatile 字段，可在 DSH 的
Web 设置面板里直接填写。

---

## 排障

凭据链任一环节出问题都会以带稳定 code 的 `LlmError` 暴露，而不是 `UNKNOWN`：

| code | 含义 |
|---|---|
| `INVALID_CREDENTIAL` | 凭据读取失败（未登录 / 会话存储损坏 / 无 `node:sqlite` 且旧链路也不可用） |
| `AUTH` | 网关 401/403，凭据被拒 |
| `RATE_LIMIT` | 网关 429（实测限流为 1 请求/秒） |
| `CONTEXT_WINDOW_EXCEEDED` | prompt 超限（已识别 OfficeAce 特有措辞） |
| `QUOTA` | 配额耗尽 |
| `TRANSPORT` | 网络不可达或流中途截断 |
| `EMPTY_RESPONSE` | 网关返回零内容块（可安全重试） |

积分读数不走 `LlmError`：它不是一个模型请求，失败时降级为「不显示」而不是
报错。读数状态有三种，客户端按状态区分处理：

| 状态 | 含义 | 界面表现 |
|---|---|---|
| `available` | 读到了积分 | 正常显示数值 |
| `unreachable` | OfficeAce 本地 API 未监听 | 整块不渲染 |
| `unavailable` | 服务在但读不到（未登录 / 身份失效 / 响应畸形） | 保留上一次的数值；从未读到过则显示「—」 |

最直接的检查方式：

```js
const { OfficeAceCredentials } = await import("./lib/credentials.js");
console.log(await new OfficeAceCredentials().diagnose());
```

`diagnose()` 只报告各环节的存在性与原因，**不会输出任何密钥**。其中
`sessionPresent` 表示积分读数所需的会话身份是否就绪。

单独检查积分读数：

```js
const { OfficeAceCreditsClient } = await import("./lib/credits.js");
const { OfficeAceCredentials } = await import("./lib/credentials.js");
const store = new OfficeAceCredentials();
console.log(await new OfficeAceCreditsClient({ credentialStore: () => store }).read());
```

返回三种状态：`available`（带 `remaining`/`total`/`groups`）、`unreachable`
（OfficeAce 未运行）、`unavailable`（带 `reason`，如 `not-signed-in`）。
