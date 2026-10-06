# 本机运维手册(OpenBot @ Windows / Git Bash)

本机这一套部署的冷启动顺序、健康检查和踩过的坑。与 `docs/development.md`(面向所有开发者的
通用文档)互补;这里记的是**这台机器**的事实,路径和令牌以本机为准,不要照抄到别的机器。

## 本机拓扑

| 项 | 值 |
|---|---|
| 仓库 | `E:\AI\OpenBot`(Bun monorepo:app / server / worker) |
| **Docker Desktop 安装位置** | **`E:\Docker\DockerDesktop\`**(不在默认的 `C:\Program Files\Docker\Docker\`) |
| docker CLI | `E:\Docker\DockerDesktop\resources\bin\docker.exe`(已在 PATH) |
| 租户包 | `examples/steel-directory`(钢贸名录团队;原 fintech 仍在,包同步只增不删) |
| 端口 | app 3010 · server 3001 · agent-computer 4100 · agent-bot 4200 · langgraph 4201 · supervisor 4500 · postgres 5432 |

## 快捷启动(日常就用这两条)

```sh
bun run up      # 一条命令拉起全部:Docker Desktop → 容器 → server/worker/前端 → 健康检查 → steel:setup
bun run down    # 停止全部;数据卷保留。加 --keep 只停宿主进程、容器留着
```

`up` 会跳过已在运行的部分(端口探测 / 进程匹配),所以**重复跑安全**;它最后会打印
app/api 地址、licence 状态、agent 数量和日志位置。等价于手动执行下面"冷启动"整节,
脚本在 `scripts/up.sh` / `scripts/down.sh`(2026-09-18 实测:全停 → 全起一个来回通过)。

## 冷启动(脚本不可用时的手动兜底)

按顺序,每步就绪再走下一步:

```sh
# 1. Docker Desktop(它不会总自启)。引擎就绪的判据是 docker info 成功。
powershell -NoProfile -Command "Start-Process 'E:\Docker\DockerDesktop\Docker Desktop.exe'"
docker info   # 循环等,通常 ~10-30s;没起来先确认进程存在,别死等

# 2. 容器栈(postgres / migrate / agent-computer / agent-bot / agent-langgraph / supervisor / spire)
docker compose up -d
docker compose ps   # 全部 running(healthy),migrate 显示 Exited(0) 是正常的

# 3. API server(3001)
cd server && nohup bun --env-file=../.env src/production-entry.ts > ../.logs/server.log 2>&1 &

# 4. worker(例程/定时任务;不跑它routine不触发,但不阻塞聊天)
cd worker && nohup bun --env-file=../.env src/index.ts > ../.logs/worker.log 2>&1 &

# 5. 前端(3010)
cd app && nohup bun run dev --port 3010 --strictPort > ../.logs/app.log 2>&1 &
```

日志都在 `.logs/`(`server.log` / `worker.log` / `app.log`)。

## 停止

`scripts/stop.sh` 在本机不可靠(Git Bash 缺 `pgrep`/`pkill`/`lsof`),手动停:

```sh
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='bun.exe'\" | Select-Object ProcessId, CommandLine"
# 看清命令行再杀,别全杀:
powershell -NoProfile -Command "Stop-Process -Id <pid> -Force"
docker compose down        # 数据都在卷里,不会丢
```

## 健康检查清单(拉起后过一遍)

```sh
curl -s http://localhost:3001/api/capabilities                 # 200
curl -s http://localhost:3001/api/copilotkit/info | jq .licenseStatus   # valid
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3010/         # 200
curl -s http://localhost:3001/api/computers/policy             # mode=enforce,1 条 deny 规则
curl -s http://localhost:3001/api/agents | jq '.agents | length'        # 9(3 fintech + 6 steel)
```

已知现象:**冷启动后第一次查 licence 可能是 `unknown`**(到 CopilotKit 的 TLS 握手冷),
隔几秒重查即 `valid`;持续 unknown 才是问题。

## 关键配置事实(`.env`)

| 变量 | 本机值 / 说明 |
|---|---|
| `COMPUTER_TOKEN` | **必须**与容器一致(compose 默认 `openbot-dev-computer-token`)。留空 → 服务器裸手发请求,容器 401,所有浏览器动作报 "Not authorised."。2026-09-18 踩过:症状是 Bot 的 read_page / 列工作区全部失败,而策略和授权都放行 |
| `TENANT_PACKAGE_DIR` | `../examples/steel-directory`;改回 `../examples/fintech` 重启即回原状 |
| `WORKER_SHARED_SECRET` | **必填,否则 worker 启动即退**(2026-09-18 补上:`openssl rand -base64 32`)。为空时例程永远不会触发,且只有 worker 日志里有报错 |
| `SERVER_INTERNAL_URL` | `http://localhost:3001` —— worker 回传例程运行结果用;和上面一条是 worker 的两个必填项 |
| `BOT_HANDOFF_MAX_DEPTH` / `BOT_HANDOFF_MAX_PER_RUN` | 1 / 6 —— 协调 Bot 一次任务能派满 5 个专家;默认 3 会派一半停下 |
| `OPENAI_BASE_URL` | 智谱兼容端点。设置了它,内置 Bot 自动走 `/chat/completions`(智谱没有 `/responses`,运行时默认的 Responses API 会 404 —— 已在 server 侧修复,勿撤) |

## 钢贸名录团队的启动项

冷启动后跑一次(幂等,重复跑安全):

```sh
bun run steel:setup    # 注册 15 工具、29 授权、5 交接、合并密码保护规则进现有策略
```

验证(只写探针数据,跑完自清理,32 项):

```sh
cd server && bun --env-file=../.env scripts/steel-directory-probe.ts
```

## 踩过的坑(按症状找)

| 症状 | 原因 / 处置 |
|---|---|
| Docker 起不来或引擎一直不就绪 | Docker Desktop 在 `E:\Docker\DockerDesktop\`,不在默认路径;用上面的 Start-Process 命令拉起,别按 C 盘路径猜 |
| Bot 的浏览器动作全部 "Not authorised.",策略/授权却放行 | `COMPUTER_TOKEN` 与容器不一致(见上表),对齐后重启 server |
| 内置 Bot 发消息永远没有回复,日志里 404 `/v4/responses` | 兼容端点没有 Responses API。保持 `OPENAI_BASE_URL` 设置状态即可(server 侧已强制 chat completions) |
| worker 起不来,`up` 说 "worker may not have started" | 看 `.logs/worker.log`:缺 `WORKER_SHARED_SECRET` 或 `SERVER_INTERNAL_URL` 都会启动即退(两个都已在 .env 补齐) |
| `bun test` 有 ~58 个失败 | 本机环境问题(符号链接 / Unix socket / shell),**与业务改动无关**;基线已存,改动后失败集应与基线逐条一致 |
| 页面里含 URL 的草稿点"发送"没反应 | 前端 composer 对 URL 做链接芯片,指针事件被拦;直接说消息或换台浏览器。API 层不受影响 |
