# Project Context — DeepSeek Harness Portal

更新日期：2026-09-04。此文件是本仓库唯一的项目级持续记忆，记录当前实现、用户已确认的方向和后续工作。功能改动完成时，必须在同一变更中同步更新本文件；部署步骤见 `DEPLOYMENT.md`，不要按旧版上游 README 或历史审计中的部署方式操作。

界面语言：Portal 默认简体中文，覆盖登录注册、用户空间入口、管理后台、个人设置、状态/角色/日期及常见错误提示。品牌名称、用户输入和原始运行日志保留原文。仅修改 `portal/public/` 后刷新浏览器即可生效，无需重建 DSH 镜像。

## 1. 用户目标与已确认决策

构建一个多人使用的 DSH 平台：每个账号自动获得独立工作空间、会话、配置及插件；用户可管理插件，后续需要一键重启；管理员后续统一管理模型 Key、每天的使用额度及 DSH 版本升级。

已确认：

- 全部使用 Docker。Windows 用 Docker Desktop 的 Linux containers；Ubuntu 用现有 Docker Engine。Portal 的 Node 服务直接运行在宿主机。
- 使用账号密码注册/登录，不使用邮箱、验证码或 SMTP。保留邀请码和注册开关。密码忘记后由管理员重置。
- 默认构建 npm `latest` 对应的 DSH；构建时解析为明确版本，部署使用不可变 `sha256` 镜像 ID。2026-09-03 实测 latest 为 `0.1.1-rc.2`。
- Windows 工作区：`F:\ai-demo\deepseek-harness-portal`。
- 服务器：Ubuntu 20.04.4 LTS、x86_64、内核 5.4、IP `10.0.9.175`，免密码 SSH `root@10.0.9.175`。
- 服务器已有 Docker 27.5.1（cgroupfs / cgroup v1）、Node 22.23.2、npm 10.9.8。约 15 GiB 内存、398 GiB 空闲磁盘；这是本次检查快照，不是容量保证。
- 管理后台使用 7000，用户入口从 7001 起。8080 已被 WeKnora 占用，不改动其服务。初期内网 IP + HTTP 端口即可，不要求域名/Cloudflare。
- origin：`https://github.com/faxi2017/deepseek-harness-portal.git`；upstream：`https://github.com/vocsong/deepseek-harness-portal.git`。本次基于 main / e0bb46f 修改，尚未提交或推送。

## 2. 当前结构和职责

| 文件/目录 | 职责 |
| --- | --- |
| `portal/src/index.js` | Fastify 入口；注册登录、会话、Profile、管理 API、启动前检查、空闲回收 |
| `portal/src/config.js` | 环境变量、资源限制、镜像 ID、端口范围校验；当前启动不要求 SMTP |
| `portal/src/db.js` | better-sqlite3；表结构、迁移、用户/实例/会话/设置查询、管理员初始化 |
| `portal/src/auth.js` | bcrypt、随机会话、CSRF、旧邮箱工具函数 |
| `portal/src/rate-limit.js` | 基于 SQLite 的 IP/账号限流，邀请码限流 |
| `portal/src/docker.js` | 跨平台 Docker CLI；对象检查；专属 bridge 网络；防火墙助手 |
| `portal/src/orchestrator.js` | 容器生命周期锁、端口分配、健康检查、运行态查询、日志、保留卷重建 |
| `portal/src/routing.js` | 用户访问 URL、公开端口到内部端口映射、Host/Origin 检查 |
| `portal/src/proxy.js` | 用户/管理员授权、HTTP 和 WebSocket 代理、自动启动、会话失效断开 WS |
| `portal/src/otp.js`、`mailer.js`、`email-change.js` | 上游保留的兼容模块；当前服务不导入它们，也不注册任何邮箱接口 |
| `portal/public/index.html`、`app.js`、`style.css` | 原生前端，登录注册、个人空间、管理员、Profile；无 Vue/React/Vite |
| `portal/test/` | 账号注册、邮箱旧兼容事务、Docker 编排、路由和 HTTP/WS 代理测试 |
| `portal/data/portal.db` | 运行时 SQLite，WAL 模式，不进入 Git |
| `image/Dockerfile` | Node 24 + Debian trixie；安装 npm DSH 和 pnpm；配置非 root 用户及持久化目录 |
| `image/patch-dsh.mjs` | 对 npm 发布包中拒绝 0.0.0.0 的监听检查做单点补丁，匹配数量不为 1 则构建失败 |
| `image/start.sh` | 从 `/workspace` 运行 DSH web，端口 3000；Node 使用 `--expose-internals` |
| `image/tenant-firewall.sh` | 针对本项目子网添加 Docker 出站/宿主机访问规则，不清空全局防火墙 |
| `image/dsh-security.patch` | 上游旧源码依赖补丁，当前 npm 构建不使用；不能据此宣称新版无漏洞 |
| `scripts/build-image.mjs`、`build-image.ps1/.sh` | Windows/Linux 共用构建逻辑，解析最新版本并输出镜像 ID |
| `run-portal.ps1/.sh` | 从项目根 `.env` 加载配置并启动 Portal |
| `scripts/check-server.sh` | Linux 只读环境和端口检查 |
| `scripts/smoke-docker.mjs` | 真实 Docker 临时容器验证，清理测试卷，保留专属网络 |
| `scripts/dsh-portal.service` | `/opt/deepseek-harness-portal` 的 systemd 模板，默认 root + 现有 Docker |
| `DEPLOYMENT.md` | 首次启动、本地修改、Git 同步、服务器更新、DSH 升级和排查 |

模型网关已接入独立 Bifrost v2.0.0 容器，见 `MODEL_GATEWAY.md`；后台增加“模型网关”页。`gateway-store.js` 管理权限/加密/额度流水，`gateway.js` 提供独立推理入口，`bifrost.js` 管理模型和内部凭证，`gateway-dsh.js` 通过 DSH 原生接口下发配置，`gateway-admin.js` 提供后台接口。`personal-usage.js` 从运行中用户 DSH 的会话历史同步已完成的个人模型用量，并以幂等事件记录写入 SQLite；不读取或存储个人 Key、提示词和回复。仍没有独立前端构建、CI 发布流水线或批量升级队列。Portal 使用 Docker CLI 控制同一台主机的实例，当前应只运行一个 Portal 进程。

## 3. 运行与数据边界

```text
浏览器
  ├─ :7000 -> Portal 登录、注册、管理、个人页面
  └─ :7001、7002… -> Portal 的租户入口（鉴权 + Host/Origin 校验）
        -> 127.0.0.1:18000、18001…
        -> Docker 专属 bridge -> dsh-<slug>:3000
             ├─ <container>-home      -> /home/dsh（.dsh / 插件 / 会话 / 配置）
             └─ <container>-workspace -> /workspace（工作文件）
```

公开端口计算：`INSTANCE_PORT_START + host_port - PORT_RANGE_START`。实际接受请求的本机监听端口决定租户，不能通过伪造 Host 改选用户；Host/Origin 还需匹配该用户 URL。默认内部 18000–18100，含两端共 101 个槽位，对应公开 7001–7101。停止的实例仍占用槽位。内部端口仅回环绑定。

默认每实例：2 CPU、2 GiB 内存/总内存加 swap 上限、512 PID、64 MiB tmpfs、有界 local 日志；非 root UID 1000、只读根、删除所有 capabilities、no-new-privileges。这是上限，不等于固定预留或整机并发能力。

用户是 SQLite 账号，不是 Linux 账号；各容器内都使用 dsh/UID1000。管理员能访问所有实例，独立空间不对管理员保密，也不提供虚拟机隔离。容器挂载自己的两个卷，没有 Docker socket 或宿主机目录挂载。

专属网络禁用 ICC、IPv6；防火墙助手短暂使用 host 网络和 NET_ADMIN，把规则限定到本项目子网。租户可访问公网，不能直接访问宿主机/私网（包括内网模型服务）。启用网关时，仅放行明确目标 IP 的 7999 模型端口；14000 Bifrost 管理端口只绑定回环。管理员指定的内网模型通过 Bifrost 访问。启动先验证 rootful Linux Docker、镜像、网络和 `DOCKER-USER` 链；失败则拒绝启动。重启 Docker 后应重启 Portal 重新应用规则。目前不支持 rootless Docker 或原生 nftables 后端。

## 4. 注册、登录和兼容性

- `POST /api/auth/register`：`{username,password,inviteCode?}`；账号 trim + 小写，3–32 位 `[a-z0-9._-]`，密码至少 8 字符且最多 72 字节；邀请码启用时必填。成功创建用户、实例记录和会话，返回用户、实例 URL、CSRF Token；异步创建容器。
- 注册串行分配端口，用户与实例记录在 SQLite 事务里写入；无容量返回 503，不留下无实例的新账号。重名返回 409，格式不合法返回 400，关闭注册/邀请码错误返回 403，限流返回 429。
- `POST /api/auth/login`：账号 + 密码。只认 username，不再使用 email 查找；密码登录始终可用。
- `/api/auth/register/request`、`register/verify`、`login/request`、`login/verify`、`/api/profile/email-change/*` 已删除，返回 404。
- Profile 可改名称、账号和密码；修改密码需验证当前密码并轮换会话。管理员 Users 页可重置普通用户密码，已有会话和 WS 会失效。
- 管理设置是 `registrationEnabled` 与 `inviteCode`。读取注册开关时兼容旧 `otp_registration_enabled`，保存后使用 `registration_enabled`。旧 password-login 开关不再生效，避免用户被锁在邮箱登录路径。
- 新用户 `email=NULL`；保留旧邮箱列、OTP 表、旧代码及兼容测试，避免破坏现有数据库。旧用户若没有 username/password，需先补全再迁移使用。本机此前没有业务用户，不涉及旧用户迁移。
- 首次启动创建 `ADMIN_NAME` 管理员，密码至少 16 字符、最多 72 字节；不需要 ADMIN_EMAIL。已有管理员时 `.env` 的初始密码不会覆盖数据库密码。
- Cookie HttpOnly、SameSite=Lax，是否 Secure 取决于 PORTAL_ORIGIN 是否 HTTPS；同 IP 不同端口共享 Cookie，依靠精确 Origin、CSRF 和用户归属保护，不依赖 Cookie 按端口隔离。
- 代理移除 Cookie、Authorization、Origin、CSRF 和转发身份信息；移除 DSH 回传 Set-Cookie。当前 DSH 内部接口通过受鉴权的 Portal 以 loopback 身份访问。

SQLite 表：users、instances、sessions、settings、auth_rate_limits，以及兼容保留的 otps。sessions 存 token 哈希与 CSRF/过期信息；密码 bcrypt。业务执行一用户一实例，但数据库 `instances.user_id` 未设置唯一约束，多进程或直接写数据库不受应用队列保障。

## 5. DSH 构建、插件与升级

从官方 npm 读取 latest，安装其明确版本；依赖下载默认 npmmirror，Debian 使用阿里云镜像；基础镜像固定内容 digest，并通过 Docker 配置的镜像加速器拉取。可用 NPM_REGISTRY/DEBIAN_MIRROR 覆盖构建源。npm 依赖子树使用上游 semver 范围，同一 DSH 版本重建可能产生不同镜像，所以真正部署依据是镜像 ID。

当前只修改 DSH 的容器监听检查；不继续套用旧源码安全补丁，也不修改系统提示词。npm 发布版 0.1.1-rc.2 在本次 Node 24 环境下运行 HMR 需要 `--expose-internals`，启动脚本已处理。Windows 单独安装的全局 dsh 与容器镜像互相独立。

home 卷包含插件 profile 和依赖；重启/重建保留。要求修改系统目录、root、额外 apt 依赖的插件不能由普通租户随意安装，需要管理员调整镜像。不能承诺任意插件都兼容新 DSH。

后台已增加“默认插件”：保存 `dsh plugin --profile web add npm包名`（每行一个），为新实例自动安装并启用；支持已有实例批量安装、自动重启、逐实例状态和重试。插件独立于镜像，已有成功配置在保留卷重建时不重复安装，不覆盖个人模型或工作区。实现为 `plugins.js`、`plugin-admin.js` 与既有编排器；说明和边界见 `DEFAULT_PLUGINS.md`。本地已保存 dshmarket 默认命令，并通过后台为 fangxi 安装 1.41.0；新用户注册自动安装及原生市场页面已验证。

升级 Portal：更新代码 + npm ci + 重启服务，不更新用户 DSH。升级 DSH：构建新镜像 + 修改 `.env` 的 DSH_IMAGE + 重启 Portal + 管理员 Reprovision 已有实例。Reprovision 保留卷；Delete 删除卷。回退镜像不等于回退已迁移的用户数据，升级前要备份。

## 6. 尚需实现的业务能力

| 需求 | 当前状态 / 下一步 |
| --- | --- |
| 账号密码注册、独立实例、管理后台 | 已实现；无需邮件服务 |
| 用户自行管理插件 | DSH 自身功能 + 持久化目录；新增后台默认插件、已有实例批量安装/重启；具体插件需验证权限和兼容性 |
| 用户一键重启 DSH | 当前有本人 start/stop API，用户页仅 Launch；需补原子 restart 操作及按钮 |
| 管理员重置密码 | 已有 API，本次补齐 Users 页面按钮 |
| 统一模型 API Key | 已接入 Bifrost；管理员配置兼容 Chat Completions 的服务，密钥加密，租户只获得平台凭证 |
| 每人每天限额 | 已实现输入+输出 Token、北京时间零点、事务预占、流式结算、429；不明回执保守扣减，细节见 MODEL_GATEWAY.md |
| 精确用量统计 | 新增用户/模型/日期汇总；request_count 仍只是代理请求数，两者独立 |
| DSH 批量升级/灰度/回滚 | 只有逐实例 Reprovision；需镜像版本记录、任务队列、进度、备份及回滚策略 |
| 防止绕过平台额度 | 平台凭证、模型权限和用量身份由 Portal 校验；保留用户自己的公网 Key，不将个人调用纳入平台额度 |
| 生产发布 | 尚未部署为服务器服务、未推送 Git；按 DEPLOYMENT.md 完成 |

网关与 DSH 镜像、用户 home/workspace 持久卷独立；下发只修改专用平台 provider，不覆盖个人模型或用户默认选择（新用户初始化或显式要求设默认时除外）。未来 DSH 版本接口仍需灰度验证。只读根文件系统与用户任意安装系统软件有明确边界。

## 7. 验证与运行状态

已完成：

- 本地构建 npm DSH `0.1.1-rc.2` 镜像，容器里的 dsh --version 确认一致。
- 49 项自动化测试：注册登录/并发/容量失败/验证码接口移除、邀请码/关闭注册/限流、管理员重置密码与会话撤销、Docker 错误传播/生命周期、端口及 HTTP/WS 代理、模型网关权限/结算及管理员与子用户多维统计隔离，以及默认插件校验、安装队列、失败恢复和生命周期冲突；其中 3 项为旧邮箱事务兼容测试。
- Docker Desktop 真实预检通过；DSH 启动、stop/start、保留两个卷重建通过；健康的同网其他租户不可访问，工作区不共享；公网 npm HTTPS 成功，私网/宿主机请求失败。
- 本地 `.env` 已生成随机管理员密码并被 Git 忽略，Portal 在 localhost:7000 运行；浏览器验证账号密码注册后自动生成 localhost:7001 的真实 DSH 实例，并正常显示 DSH 模型 Key 配置页。测试账号及其容器、卷已清理，本地保留管理员及登录页供用户试用。

网关新增验证：MiniMax-M3 直连与经过 Bifrost 的普通/流式调用、实际 Token 对账、超限 429、撤销 401、个人模型与工作文件保留、凭证轮换后同镜像重建保留个人默认模型和私网隔离；浏览器完成原生 DSH 对话、模型编辑和用户配置下发。最终流式调用 201 Token 与回执一致，全部自动化测试通过。详见 MODEL_GATEWAY.md。本地已部署网关，fangxi 已获平台模型，个人默认模型保留；新用户默认每日 1,000,000 Token。临时测试账号、容器和卷已清理，现有 admin/fangxi 保留。密钥不写入文档。

模型网关“用量分析”已增加 CC Switch 风格的统一筛选指标卡、折线/柱状趋势、用户排行、模型环图、星期/小时热力图、请求状态、四种明细汇总和 CSV 导出。子用户 Portal 也有独立“模型网关”页，可按时间、模型和粒度查看自己的同口径指标、趋势、模型分布、热力、请求状态和明细导出；后端固定会话用户并拒绝 `userId` 参数，不返回其他用户身份或用量。后台与个人页现在同时汇总平台模型和已同步的 DSH 个人模型用量，明细标明来源；个人模型只在 DSH 返回完成用量后记录，绝不扣平台额度。同步仅访问运行中实例的会话历史，按用户串行、30 秒缓存、最多扫描每会话 20 页 × 100 条事件，以 `(user_id, session_id, event_seq)` 去重。后端从一次 SQLite 读事务返回所有维度，按北京时间汇总，并将实际用量、待核实扣减和预留额度分开；不虚构当前没有持久化的缓存、价格或延迟数据。

未验证：货币计费、所有插件的安装更新、未来 DSH 版本兼容性、生产负载、Ubuntu 上 Portal/网关服务完整部署、批量升级和数据版本回滚。服务器仅此前检查环境并缓存了基础镜像，没有替换现有业务或重启 Docker。

`SECURITY_AUDIT.md` 为 2026-08-16 上游旧源码/运行方式的历史报告，不是当前 Docker/npm latest 版本的安全认证。
