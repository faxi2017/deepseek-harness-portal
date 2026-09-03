# 模型网关：配置、边界与验收

## 选型与运行方式

本项目采用 **Bifrost v2.0.0**，固定镜像 digest 为 `sha256:cf71be9fad4e0749b6e26cbb774c687413dad9a0970b83f4e1dadb6f503ea208`。没有 fork 或修改 Bifrost / DSH 的模型实现。

| 候选 | 与本项目的关系 | 决定 |
| --- | --- | --- |
| [Bifrost](https://github.com/maximhq/bifrost) | Apache 2.0，独立 Docker 服务，管理 API、兼容接口、虚拟密钥；可使用本地 SQLite | 采用；Portal 对接它的 API |
| [LiteLLM](https://docs.litellm.ai/docs/proxy/virtual_keys) | 虚拟密钥和用量治理成熟；内置预算主要是金额，完整代理治理通常还需数据库 | 可替代，但本次不增加另一套用户管理 |
| [New API](https://github.com/QuantumNous/new-api) | 完整独立分发管理平台，采用 AGPLv3 及其仓库列出的许可条款 | 本项目已有用户和后台，暂不引入第二个面向用户的平台 |

Bifrost 提供模型路由、协议处理、上游密钥管理。Portal 持有账号权限、每日 Token 额度和结算流水。Bifrost 的内置额度是请求前检查、调用后记账，并不能直接满足本项目的并发预占和北京时间日界；这里明确使用 Portal 的 SQLite 事务进行预占，不把金额预算冒充 Token 额度。[Bifrost 限额说明](https://docs.getbifrost.ai/features/governance/budget-and-limits)

```text
用户 DSH（个人 home / workspace 卷）
  ├─ 个人模型 → 个人 API Key → 原有公网出口
  └─ 平台模型 → 用户专属平台凭证 → 宿主机 :7999/v1
       → Portal：用户/模型鉴权、额度预占
       → 127.0.0.1:14000 Bifrost：内部虚拟密钥 + 上游密钥
       → 管理员配置的模型服务
       → Portal：流式转发、用量结算
```

管理员在原 Portal 左侧“模型网关”管理全部功能，不需要登录 Bifrost 后台。14000 只绑定回环，租户只获准访问指定 IP 的 7999 模型端口；原有其他租户、宿主机、私网限制继续保留。管理员明确配置的内网模型由 Bifrost 访问，不对租户开放该内网端点。

## 启动与配置

在已有 Portal 项目根目录执行（Windows / Linux 相同，Node 22+）：

```sh
node --env-file=.env scripts/start-gateway.mjs
```

该脚本拉取固定镜像，创建本项目专用的 `dsh-portal-bifrost` 容器，设置管理与推理鉴权、密钥加密和关闭内容日志。遇到同名但不属于本项目的容器会拒绝操作。镜像下载可能需要 Docker 镜像加速或可用网络。

在 `.env` 中设置 `MODEL_GATEWAY_ENABLED=true`，重启 Portal。默认使用 `MODEL_GATEWAY_PORT=7999`、`BIFROST_URL=http://127.0.0.1:14000`。不需要重建 DSH 镜像。Windows 自动选择 Docker Desktop 的 `host.docker.internal`；Linux 自动选择专用租户 bridge 的网关 IP。通常无需填写 `MODEL_GATEWAY_TENANT_URL`；如确需覆盖，必须是 `http://<租户可达宿主机地址>:7999/v1`。

1. 管理员进入“模型网关”，添加名称、上游模型 ID、基础地址、API Key、单次最大输出 Token。
2. 本版本后台接入兼容 OpenAI Chat Completions 的模型服务。地址填 `https://example.com/v1`；粘贴完整 `/v1/chat/completions` 也会自动规范化。API Key 输入框留空表示保留原密钥，查询接口不回传密钥。
3. 配置新用户默认模型、每日 Token 额度和自动分配开关。没有配置时默认不为新用户授予模型权限；本地联调已设置 MiniMax-M3、每日 1,000,000 Token。
4. 对已有用户点击“配置”：选择可用模型和额度。点击“仅保存权限”立即改变网关权限；“保存并下发”同时更新运行中的 DSH。停用不要求 DSH 在线。
5. “下发时设为默认”是可选操作，默认不勾选。新注册且启用默认分配的用户会自动下发并设置平台默认模型。用户仍可以在 DSH 添加或选用自己的模型。
6. 重置用户平台凭证会立即拒绝旧凭证；随后“保存并下发”将新凭证写入 DSH。重置凭证不清零已用额度。
7. 查看按用户、模型和日期汇总的输入/输出 Token、扣减/预留、请求数、失败数及待核实数。用户自己的 Portal 首页只显示自己的额度。

本地联调使用用户提供的 MiniMax-M3，基础地址 `http://192.168.60.210:3000/v1`。密钥未写入本文、源码、测试代码或 Git。

## 额度口径

- 每用户每日额度合计所有获准平台模型，按 **Asia/Shanghai 00:00** 划分。0 表示禁止调用，不表示无限。
- 已知用量按 `prompt_tokens + completion_tokens` 计算；缓存输入、推理输出已包括在相应字段内，不重复相加。本次不计算货币费用。
- 请求前按文本 UTF-8 大小、消息/工具结构开销和最大输出做保守预占，事务内检查剩余额度。没有足够余额会返回 429；长上下文可能在实际余额耗尽前因预占不足被拒绝，可缩短上下文/输出或提高额度。
- 预占是估算，不显示为实测 Token。最终以模型回执的用量替换预占。该估算适用于已测试的文本/工具协议，不能承诺为任意供应商的私有分词、隐藏提示词或违规超额输出提供数学上界；更换供应商要重新验证回执和输出上限遵守情况。
- 当前平台接口支持文本和工具调用、普通与 SSE 流式回复；拒绝多回复 `n>1` 和图片/音频请求，避免未实现计量的输入绕过额度。个人模型路径保持原功能。
- 流式请求强制请求最终 `usage`，断开浏览器后继续在有界超时内收取上游用量。没有有效用量回执、超时、进程中断等情况按预占扣减并标记“待核实”；不会无依据退款。
- 明确未处理请求的常见上游 4xx 失败不扣减；其他结果不明的失败保留预占。平台不自动重试计费请求，避免重复消费。
- 请求开始时固定所属日期；跨日完成归到开始日。重启 Portal 后未结算请求转为待核实，不丢失扣减。降低额度/停用权限阻止之后的新请求，已开始的请求继续结算。
- 客户端不能通过请求体中的 `user`、模型路由、上游 Key/Base URL、fallback 等字段改变用户归属或绕过网关。仅向 Bifrost 传递允许的推理参数。
- 个人模型、自带 API Key 不计平台额度。平台额度不是对用户全部公网 AI 调用的封锁。

## 配置存储和升级

- `gateway_models`：模型定义、加密的上游密钥、启用/同步状态。
- `gateway_users`：用户专属凭证的哈希与加密副本、授权模型、每日额度、DSH 下发状态。
- `gateway_requests`：预占、日期、实际输入/输出 Token、扣减与状态；不保存提示词、输出正文、附件或上游错误正文。
- `portal/data/gateway.key`：Portal 加密根密钥；必须与数据库一起备份，丢失后无法解密已有模型凭证。Linux 创建权限为 0600；Windows 应限制运行账号目录访问权限。
- `portal/data/bifrost/`：Bifrost 配置、加密数据库、启动环境；仅服务端使用。不要提交此目录。管理员凭证派生自根密钥，Bifrost 内部虚拟密钥不会进入用户 DSH。
- 全部新增记录独立于 DSH 镜像。下发通过当前官方 `settings.describe` / `settings.mutate` / `credentials.set` 接口，仅维护 `llm-pi-ai.providers.portal-gateway` 和 `PORTAL_GATEWAY_API_KEY`。使用版本校验和路径级更新，保留个人模型、密钥、插件配置。
- 正常 Portal 启动和已配置用户的 DSH 重建，不反复覆盖用户的模型选择。更改权限即时生效；更改 DSH 列表/名称等展示配置时手动重新下发。
- DSH 升级仍按原来的构建镜像 → 修改 `DSH_IMAGE` → 重建实例流程，保留两个用户卷。已测试同镜像重建的持久化路径；未来 DSH 版本的 API 和插件兼容性需灰度验证，不能由本次测试保证。下发失败会显示错误，实例保持可用。
- Bifrost 升级独立进行，不跟随用户 DSH 升级。先备份 `portal/data`（包含根密钥、Portal DB 和 Bifrost DB）与租户卷，再验证目标版本。本次脚本遇到已有网关容器仅启动，不隐式替换镜像或删除网关数据。
- 继续只运行一个 Portal 进程；跨进程/多副本部署、网关集群、货币计费不在本次实现范围。

## 主要接口

| 接口 | 用途 |
| --- | --- |
| `GET /api/admin/gateway` | 健康、模型、所有子用户额度与默认配置，均脱敏 |
| `POST /api/admin/gateway/models` | 新增/编辑模型：`id? name baseUrl upstreamModel apiKey? maxOutputTokens enabled` |
| `POST /api/admin/gateway/models/:id/sync` | 重试同步模型到 Bifrost |
| `POST /api/admin/gateway/settings` | `{enabled, defaults:{enabled,dailyTokens,models:[模型ID]}}` |
| `POST /api/admin/gateway/users/:id` | `{enabled,dailyTokens,models:[模型ID]}` |
| `POST /api/admin/gateway/users/:id/sync` | `{setDefault?:boolean}`，仅下发至此用户 |
| `POST /api/admin/gateway/users/:id/rotate` | 撤销并轮换平台凭证，不清空用量 |
| `GET /api/admin/gateway/usage?from=YYYY-MM-DD&to=YYYY-MM-DD` | 日/用户/模型汇总，最多一年 |
| `GET /api/gateway/me` / `POST /api/gateway/me/sync` | 用户自己的额度/模型及配置下发 |
| 独立端口 `GET /v1/models` / `POST /v1/chat/completions` | 只接受平台 Bearer 凭证，无管理 API |

管理和用户操作复用 Portal 登录、角色、Host/Origin/CSRF 检查，模型推理端口只接受专属 Bearer 凭证。

## 验证

```sh
npm test --prefix portal
node --env-file=.env scripts/smoke-gateway.mjs MiniMax-M3
```

第二条会实际调用已配置模型并消耗少量 Token，创建独立的临时用户/容器/卷，在结束时只清理本次创建的测试资源。需要 Portal 和 Bifrost 已运行。它验证普通/流式调用和实测用量、超限 429、撤销 401、个人模型保留、保留卷重建、宿主机和内网隔离。

2026-09-03 本地验收结果：

- 全部 35 项自动化测试通过，包含并发预占、权限隔离、跨日结算、重启恢复、异常输入、流中断保留预占、Bifrost 空回复项用量回执和原有 Portal 回归。
- MiniMax-M3 实际普通与流式冒烟调用合计 416 Token，与模型回执一致；超限返回 429，轮换后旧凭证返回 401。最终代码重启后额外验证流式调用：输入 180、输出 21，扣减 201，预留和新增待核实均为 0。
- 浏览器通过新用户注册自动下发，在原生 DSH 完成真实对话；工具调用返回有效函数调用。后台可查看按用户/模型/日期统计，密钥留空保存和权限保存并下发均通过页面操作验证。
- 临时实例添加个人模型、个人密钥、工作区文件，选择个人默认模型后轮换平台凭证并保留卷重建；个人配置、默认模型和工作区均保留。租户不能直接访问内网模型地址、Portal 管理端口或 Bifrost 端口。
- 测试账号、实例和对应测试卷已经清理。现有用户保留个人默认模型，平台 MiniMax-M3 配置可由用户自行选用。

服务器尚未部署本功能；以上结果均为本地验证。未来不同版本的 DSH 升级仍需按兼容性说明灰度验收。
