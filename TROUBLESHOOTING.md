# Ubuntu / Docker 部署故障排查与运行边界

本文记录 DeepSeek Harness Portal 在 Ubuntu Docker Engine 环境中实际遇到过的问题、可复现的判断方法、已验证的处理方式，以及为保证隔离与数据安全而明确不采用的“快速绕过”。它适用于首次部署、升级、插件批量安装和日常恢复。

> 本文不应替代备份。修改 `.env`、升级镜像、批量安装插件或修改防火墙前，先备份 `DATA_DIR` 下的 SQLite 数据库和 `.env`；用户的 `/home/dsh`、`/workspace` 位于 Docker 卷，需单独备份。

## 先收集这组信息

以下命令不会修改状态，足以区分绝大多数环境问题。请在项目根目录执行；不要把 `.env` 内容、会话 Cookie、DSH token 或完整容器日志中的用户数据公开到 issue。

```bash
node --version
docker version --format '{{.Server.Version}}'
docker info --format '{{.OSType}} {{json .SecurityOptions}}'
iptables --version
iptables-legacy --version 2>/dev/null || true
iptables-nft --version 2>/dev/null || true
ss -ltnp | grep -E ':(7000|7001|18000)\b' || true
docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'
tail -n 120 /tmp/dsh-portal.log 2>/dev/null || true
```

Portal 的服务状态和某个用户实例的状态需要分开看：

```bash
cd /path/to/deepseek-harness-portal
cat .portal.pid 2>/dev/null && ps -fp "$(cat .portal.pid)"
docker inspect dsh-<用户-slug> \
  --format 'status={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} restarts={{.RestartCount}}'
docker logs --tail 160 dsh-<用户-slug>
```

DSH 根路径可能返回 `401` 或 `403`，这通常表示服务已就绪但要求登录；它不同于连接失败。Portal 已将受认证保护的响应视为健康。

## 1. `better-sqlite3` 无法安装或加载

### 症状 A：预构建二进制要求更高版本的 GLIBC

常见错误类似：

```text
GLIBC_2.33 not found
.../better-sqlite3/prebuilds/linux-x64.node
```

**原因**：下载到的预构建 `.node` 是在比当前 Ubuntu 更高版本的 glibc 上编译的。Ubuntu 20.04 的 glibc 较旧时尤为常见。

**处理**：在目标服务器上使用本机 Node ABI 和 C/C++ 工具链从源码重建，并确保运行时不再优先加载不兼容的预构建文件。优先执行项目的依赖安装流程；需要诊断时可在 `portal` 目录检查：

```bash
npm ci
npm rebuild better-sqlite3 --build-from-source
node -e "const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.close(); console.log('better-sqlite3 OK')"
```

### 症状 B：`g++: unrecognized command line option '-std=c++20'`

**原因**：编译器过旧。部分 Ubuntu LTS 默认的 GCC 9 只接受早期实验选项，不能编译要求正式 C++20 的原生模块。

**处理**：安装受支持的较新 GCC（例如 GCC/G++ 11 或更高），只对本次 Node 原生模块构建指定 `CC` / `CXX`，避免改动系统默认编译器：

```bash
CC=/usr/bin/gcc-11 CXX=/usr/bin/g++-11 npm rebuild better-sqlite3 --build-from-source
```

**不要这样做**：

- 不要下载来源不明的 `.node` 文件覆盖 `node_modules`。
- 不要为了加载一个预构建模块升级或替换系统 glibc。
- 不要把服务器的 `node_modules` 拷回 Windows，或反向覆盖服务器；原生模块必须按各自平台安装/构建。

## 2. Portal 启动时防火墙失败

### 症状：`DOCKER-USER` 链不存在，或出现 legacy/nft 警告

典型输出：

```text
# Warning: iptables-legacy tables present, use iptables-legacy to see them
iptables: No chain/target/match by that name.
```

**原因**：宿主机 Docker 使用 `iptables-legacy`，而防火墙助手容器内的 `iptables` 指向 `iptables-nft`（或相反）。两个规则表互不可见，因此助手找不到 Docker 创建的 `DOCKER-USER` 链。

**确认**：

```bash
iptables-legacy -t filter -S DOCKER-USER
iptables-nft -t filter -S DOCKER-USER
```

只要其中一个能输出 `-N DOCKER-USER`，它就是当前 Docker 使用的后端。

**处理**：项目的 `image/tenant-firewall.sh` 会检测包含 `DOCKER-USER` 的后端并使用它。更新项目代码和镜像后重启 Portal；Docker daemon 重启过时，也应重启 Portal 以重新应用规则。

### 症状：`Fatal: can't open lock file /run/xtables.lock: Read-only file system`

**原因**：防火墙助手是只读根文件系统，iptables 仍需要运行时锁文件。

**处理**：助手容器必须为 `/run` 提供受限可写 tmpfs；本项目已使用：

```text
--read-only
--tmpfs /run:rw,nosuid,nodev,noexec,size=64k
--cap-drop ALL
--cap-add NET_ADMIN
--cap-add NET_RAW
```

**不要这样做**：

- 不要全局切换 Ubuntu 的 `update-alternatives` 来“修复”一个项目容器；这会影响已有 Docker 和其他服务。
- 不要删掉 `--read-only`、`cap-drop ALL` 或为租户容器添加 `NET_ADMIN`。
- 不要因为链错误而跳过防火墙助手或开放租户访问宿主机/私网。隔离失败必须让 Portal 启动失败，而不是带病运行。

## 3. `.env` 管理员密码无法登录

### 症状：看起来正确的密码始终返回“账号或密码错误”

**原因 A：未加引号的 `#` 被当作注释。** Node 的 `--env-file` 遵循 dotenv 语义，例如：

```dotenv
ADMIN_PASSWORD=example-password#suffix
```

实际读取到的可能只是 `example-password`。带 `#`、空格或其他容易被 shell/dotenv 解释的值应使用双引号：

```dotenv
ADMIN_PASSWORD="example-password#suffix"
```

保存后不要打印密码本身；只验证长度和登录接口状态即可。

**原因 B：管理员只在首次启动创建。** `ADMIN_NAME` 和 `ADMIN_PASSWORD` 是 seed 配置：数据库已经存在管理员后，修改 `.env` 不会覆盖数据库哈希。因此即使 `.env` 已修正，旧管理员密码仍可能保留。

**处理顺序**：

1. 给特殊字符密码加双引号并限制 `.env` 权限：`chmod 600 .env`。
2. 用当前可用管理员会话在管理页重置密码；如果没有可用会话，先备份数据库，再使用项目的受控管理恢复流程更新管理员密码哈希。
3. 重启 Portal 后，以真实登录请求验证，不只比较配置文件文本。

**不要这样做**：

- 不要通过删除 SQLite 数据库来“重置管理员”；这会丢失用户、会话、实例和平台设置。
- 不要在 issue、聊天记录、日志或 shell 历史中粘贴生产密码。
- 不要假定修改 `.env` 会自动修改已有管理员。

## 4. Portal 停止、后台启动和重复进程

推荐使用仓库提供的脚本：

```bash
cd /path/to/deepseek-harness-portal
bash stop-portal.sh
nohup bash run-portal.sh >/tmp/dsh-portal.log 2>&1 </dev/null &
```

`run-portal.sh` 写入 `.portal.pid`，`stop-portal.sh` 会校验 PID 的工作目录和命令行后再发送 `TERM`，避免误杀其他 Node 服务。长期运行请使用 `scripts/dsh-portal.service` 交给 systemd 管理。

**不要这样做**：

- 不要使用 `pkill node`、`killall node` 或按端口模糊匹配的广泛 kill 命令。
- 不要同时运行 systemd 服务和 `nohup bash run-portal.sh`；两者会抢占 7000 端口。

## 5. 新用户实例“创建中”或启动后无法进入

### 症状：实例状态长期不变、启动检查失败，或用户入口无法加载

按顺序检查：

```bash
docker inspect dsh-<用户-slug> --format 'status={{.State.Status}} exit={{.State.ExitCode}}'
docker logs --tail 160 dsh-<用户-slug>
curl -i http://127.0.0.1:<内部端口>/
```

内部端口的 `200`、`401`、`403` 都可能说明 HTTP 服务已启动；连接被拒绝、持续重启或日志中 DSH boot error 才是启动问题。Portal 的用户入口还会验证用户会话、来源和 DSH 登录 Cookie；不要直接把内部端口公开到局域网。

### 症状：DSH 已启动，但经 Portal 打开页面仍要求认证/无法进入

**原因**：DSH Web 使用一次性 bootstrap token 和按实例隔离的认证 Cookie。代理若不转发正确的 DSH Cookie，或把 Portal 会话 Cookie 错发给上游，会导致循环登录或安全问题。

**处理**：使用 Portal 生成的“进入工作空间”链接。项目代理会从实例最新启动日志读取格式受限的 bootstrap token，仅在初次入口注入，并且只转发目标实例的 `dsh-auth-*` Cookie；不会把 `portal_session` 发送给 DSH。

**不要这样做**：

- 不要把包含 bootstrap token 的完整 URL 长期保存、分享或写进截图。
- 不要关闭 Origin/Host 校验，也不要将内部 18000+ 端口对外暴露来绕过 Portal。

## 6. 默认插件批量安装失败

### 问题一：插件版本与 DSH 镜像版本不兼容

实际案例：在 DSH `0.1.2-rc.1` 上，`@wsz987/dsh-channels@latest` 会解析为 `0.5.0`。该版本依赖旧的 DSH 接口，启动时可能报：

```text
The requested module '@deepseek-ai/dsh-agent-presets'
does not provide an export named 'resolveSessionPreset'
```

另一个早期错误可能是：

```text
Cannot find package '@deepseek-ai/dsh-host-apiproxy'
```

这是插件发布时的 peer dependency/运行时接口与当前 DSH 不匹配，不是 Ubuntu 本身的问题。对于已验证的 DSH `0.1.2-rc.1`，请固定使用：

```text
dsh plugin --profile web add -w @wsz987/dsh-channels@0.4.1
```

不要使用 `@latest`，直到在目标 DSH 镜像上完成灰度验证。插件与 DSH 都处于快速迭代期，本文的兼容矩阵不是永久承诺；升级任一方后先在测试用户实例验证。

### 问题二：在运行中安装插件使实例自重载

DSH profile 的 `patchReload: live` 可能在依赖写入后重新加载主进程。若使用 `docker exec` 在正在运行的实例中执行 `dsh plugin add`，安装子进程可能随主进程退出而被杀死（常表现为退出码 `137`），Portal 便会显示安装失败。

**处理**：Portal 已采用离线安装流程：

```text
停止用户实例
  -> 一次性受限 helper 容器挂载同一个 <实例>-home 卷安装插件
  -> 启动用户实例
  -> 通过认证保护的 HTTP 健康检查
```

安装 helper 仍使用普通用户、只读根文件系统、能力全丢弃和项目专属网络；它不拥有 Docker socket。用户数据仍保留在原卷中。

### 问题三：GitHub tarball 解析慢或超时

带 `https://github.com/.../releases/latest/download/*.tgz` 的插件在 pnpm 解析其他包时也可能触发 HEAD 请求。网络抖动时常见：

```text
ERR_SOCKET_TIMEOUT
```

**处理**：

- Portal 会跳过版本或 tarball 来源已匹配的插件，避免“重试”反复下载相同内容。
- 新实例首次安装仍需访问来源。检查 DNS、HTTPS 出站和代理策略；可在项目专属网络内做最小 HTTP 探测。
- 对正式发布，优先使用带明确版本和校验信息的不可变发布地址，而不是长期依赖 `latest/download`。

**不要这样做**：

- 不要为了插件下载给所有租户容器 `--network host`，或解除私网拦截。
- 不要把安装 helper 改成特权容器。
- 不要把“批量安装失败”简单归因于内存；先看容器日志、退出码、helper 日志和 pnpm 的实际网络错误。

## 7. 端口、网络与 Docker 重启

Portal 默认公开 7000 和用户入口端口；容器内部服务仅发布到宿主机回环的 18000+ 端口。部署前确认端口范围没有与已有服务、反向代理或防火墙策略重叠：

```bash
ss -ltnp | grep -E ':(7000|7001|7101|18000|18100)\b' || true
```

Docker daemon 重启后，网络链和防火墙规则可能重建。重启 Docker 后应重启 Portal，并确认项目网络与 `DOCKER-USER` 链恢复；不要手工删除项目管理的网络、卷或防火墙规则。

## 8. 面向 issue 的最小诊断材料

提交公开 issue 时，请提供以下信息，并先删除 IP、域名、账号、token、Cookie、密码、模型 Key 和用户文件路径：

```text
Portal 版本/commit：
操作系统及版本：
Node 版本：
Docker Server 版本：
DSH 镜像版本和不可变 image ID 的前 12 位：
是否 rootful Linux Docker：
实例状态（running/exited、exit code、restart count）：
Portal 日志最后 80 行（已脱敏）：
目标实例日志最后 160 行（已脱敏）：
复现步骤：
预期结果与实际结果：
```

不要上传 `.env`、`portal.db`、Docker 卷归档或完整 `docker inspect` 输出；这些内容很容易包含凭据和个人数据。

## 发布前检查清单

- [ ] `.env`、数据库、日志、卷备份和 `.portal.pid` 都被 `.gitignore` 排除。
- [ ] README 只包含示例地址和示例密码，不包含真实服务器信息。
- [ ] `npm test --prefix portal` 通过。
- [ ] 在目标 Ubuntu/Docker 环境实际验证：管理员登录、注册新用户、启动/停止/重启实例、进入工作空间、默认插件安装。
- [ ] 插件使用明确版本；`latest` 仅在测试实例验证后使用。
- [ ] 防火墙后端和 `DOCKER-USER` 链检查通过，租户不能访问宿主机/私网。
- [ ] HTTPS、备份策略、systemd 服务和恢复流程已在生产环境演练。

