# DeepSeek Harness Portal

每个 Portal 用户对应一个独立的 DeepSeek Harness 容器。本分支使用 **Docker**，支持 Windows Docker Desktop（Linux containers）和 Ubuntu Docker Engine。Portal 是直接运行在宿主机上的 Node.js 服务。

默认入口：管理后台 `http://localhost:7000`，用户空间 `http://localhost:7001`、`7002`……。服务器对应 `http://10.0.9.175:7000`。无需先配置域名或 Cloudflare。

## 快速开始（Windows PowerShell）

需要 Node.js 22.23+、npm、Git，以及已启动的 Docker Desktop。

```powershell
cd F:\ai-demo\deepseek-harness-portal
npm ci --prefix portal
.\build-image.ps1
Copy-Item .env.example .env
notepad .env
.\run-portal.ps1
```

停止 Portal（以及同一进程内的模型网关）：

```powershell
.\stop-portal.ps1
```

如需先确认将要停止的进程，可运行 ` .\stop-portal.ps1 -WhatIf`。该命令不会停止服务。Docker 租户容器会保留，可在 Portal 管理页按需停止。

复制配置文件只做一次。编辑 `.env`：填写自己设置的至少 16 位 `ADMIN_PASSWORD`，将构建输出的 `DSH_IMAGE=sha256:...` 填入。浏览器打开 `http://localhost:7000`，管理员用户名默认 `admin`。用户直接填写账号、密码、确认密码注册，无需邮箱和验证码。

完整的首次部署、日常同步、镜像升级、备份和故障排查见 [DEPLOYMENT.md](DEPLOYMENT.md)。项目代码分析、已实现功能与后续计划见 [project_context.md](project_context.md)（兼容入口：[AgentContext.md](AgentContext.md)）。

## 运行结构

```text
浏览器 -> Portal :7000（登录 / 管理 / 用户页）
       -> Portal :7001、7002…（用户入口，HTTP 和 WebSocket 鉴权）
              -> 127.0.0.1:18000、18001… -> Docker 容器 :3000
                 每用户独立 home + workspace 卷
```

- `portal/src/index.js`：Fastify API、启动校验、管理操作和空闲停止。
- `portal/src/docker.js`：Docker CLI、专属 bridge 网络和出站防火墙。
- `portal/src/orchestrator.js`：容器创建/启动/停止/重建/删除、卷、资源限额、健康检查。
- `portal/src/routing.js`、`proxy.js`：端口/子域名路由、权限和 Origin 校验、HTTP/WS 代理。
- `portal/src/db.js`：SQLite WAL，账号、会话、验证码、设置、实例和认证限流。
- `portal/public/`：原生 HTML/CSS/JS，无单独前端打包步骤。
- `image/`：npm 发布版 DSH 镜像、受检查的容器监听补丁、启动脚本、防火墙助手。
- `scripts/build-image.mjs`：查询官方 npm latest，安装明确版本，输出不可变镜像 ID。

## 构建源和版本

基础镜像下载使用 Docker Engine 的 `registry-mirrors`。镜像内部 apt 默认阿里云 Debian 镜像（保留 Debian 签名验证），npm 默认 `https://registry.npmmirror.com`。构建脚本仍从官方 npm 查询最新版本，镜像若尚未同步该版本会报错，不静默降级。

可通过 `NPM_REGISTRY` 和 `DEBIAN_MIRROR` 环境变量覆盖构建下载源，详见部署文档。DSH 不会在用户容器内在线升级：管理员在“DSH 版本”页构建固定镜像、选择测试实例灰度升级。每次切换会先备份用户的 home 与 workspace 卷，目标版本健康检查失败会自动恢复旧镜像和数据；成功记录也保留快照供手动回退。

## 数据和权限

容器 `dsh-<slug>` 使用 `<name>-home:/home/dsh`（含 `.dsh` 配置、会话和插件）及 `<name>-workspace:/workspace`。重建保留卷；管理员“删除实例/用户”会删除对应卷。独立卷不等于对管理员保密，也不是虚拟机隔离。

租户容器使用 UID 1000、cap-drop ALL、no-new-privileges、只读根文件系统、CPU/内存/PID 限额和有界日志。网络禁用同 bridge 互通；启动时短暂运行带 NET_ADMIN 的防火墙助手，只添加本项目子网的规则，拒绝租户访问宿主机和私网。租户本身不获得 Docker socket 或该权限。Portal 服务账号拥有 Docker 管理权限，应视为宿主机高权限服务。

Docker 使用 rootful Linux daemon；支持 Docker Desktop 内部的 Linux daemon。当前防火墙实现依赖 Docker 的 iptables `DOCKER-USER` 链，配置不兼容时启动失败。重启 Docker 后应重启 Portal 以重新验证和应用规则。

账号支持用户名密码注册/登录、修改密码、邀请码、注册开关和管理后台。无需 SMTP，邮箱注册/登录/变更接口已移除。忘记密码由管理员重置。HTTP 内网试用不加密凭证，正式使用建议 HTTPS。

## 验证

```powershell
npm test --prefix portal
```

测试覆盖账号密码注册/登录/重置、旧邮箱兼容事务、Docker 命令与故障处理、生命周期串行化、端口路由与 Origin 校验、真实 HTTP/WS 代理转发与凭证移除；测试使用临时数据库，不依赖真实 Docker。真实容器验证另见 `scripts/smoke-docker.mjs`（按部署文档运行）。

`SECURITY_AUDIT.md` 是上游旧版本的历史审计，不能作为本次 Docker/npm 最新版的审计结论。
