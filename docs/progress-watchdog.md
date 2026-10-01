# 开发进度看门狗

本工具只观察本项目登记的工作，防止长操作和开发停滞静默发生。实现位于 `tools/progress-watchdog/watchdog.py`，仅用 Python 3 标准库，运行目标为提供 `/proc` 与 `fcntl` 的 Linux。它不接入游戏运行时，不改 UI，不安装依赖，不访问网络，也不发送用户消息。

## 运行边界

- 每 60 秒读取一次操作日志，写本地 `status.json` 与 `status.jsonl`
- 连续 20 分钟没有新的、显式确认的实质进展，产生 `no_meaningful_progress` 警告
- 每项工作有独立绝对截止时间；默认上传 600 秒、测试/构建 900 秒、开发切片 7200 秒、其他 1200 秒。新检查点不会延长截止时间
- 日志原子替换、文件与目录 fsync，并用独立锁串行化写入；完整日志包含操作 ID、类型、开始时间、最后实质进展、活动时间、状态、截止时间、进程身份、环境身份和远程标识
- 检查不会改变操作状态，也不会重置进展时间。定时检查、打印输出、文件时间、日志长度、PID 存活、轮询、传输活动都不算实质进展
- 环境 boot ID、PID namespace、PID 1 开始时间用于发现重启/容器替换；PID 的开始 ticks 用于区分原进程和复用 PID。已死亡、僵尸或不可观察的登记进程产生警告，不推断远程写入失败
- 工具不会自动恢复、重跑、重传、发 Git 命令或杀死已存在的其他进程。已取消、失败或成功的操作不会隐式重开

## 启动

从仓库根目录执行。只有集成负责人运行测试、构建、安装及 Git 操作，其他工作者提交检查点和请求。

```sh
python3 tools/progress-watchdog/watchdog.py start \
  --id development-20261001-01 --kind development --deadline-seconds 7200
python3 tools/progress-watchdog/watchdog.py watch
```

`watch` 立即检查一次，随后每 60 秒检查；保持前台更容易看到异常。需要后台运行时，可以由已获授权的执行环境管理器保持该进程；本工具不安装系统服务或修改开机配置。同一状态目录只允许一个持续 watcher。一次性检查可以与 watcher 共存：

```sh
python3 tools/progress-watchdog/watchdog.py once
```

退出码：`once` 为 0 表示已登记工作无当前警告，为 1 表示有警告；参数/写入等工具错误为 2。不存在或损坏的 journal 会产生观察失败警告，不报告“正常”。正常结束 watcher 不会修改正在执行的操作。

默认状态目录是 `tools/progress-watchdog/state/`，目录内 `.gitignore` 忽略运行产物。可在子命令前用 `--state-dir /a/persistent/directory` 指定已获授权的持久目录。没有读取到原状态时，不要创建同 ID 的新工作来假装续跑，先核实旧工作与远端实际状态。

## 什么算实质进展

人工或集成流程必须先核实事实，再登记新证据。允许 `artifact_verified`、`tests_completed`、`remote_verified`、`milestone` 四类。示例仅示范命令格式，不声称对应检查已经执行。

```sh
python3 tools/progress-watchdog/watchdog.py checkpoint development-20261001-01 \
  --evidence-id focused-validation-01 --kind tests_completed \
  --reference 'local-validation:unique-run-id:passed' \
  --summary '已核实本次指定范围的测试结果；完整项目验收另计'
```

重复 evidence ID，或相同类型和 reference 的重复证据，不推进时钟。不得通过换 ID 重复同一事实；引用应指向新验证运行、精确提交/内容哈希或已接受的具体里程碑。工具无法替人判断证据是否真实，因此调用方对核实负责。不要把“仍在运行”“正在上传”“又检查一次”作为 milestone。

纯活动和远端 run/commit/deployment 标识使用以下命令；它不会算作进展：

```sh
python3 tools/progress-watchdog/watchdog.py activity development-20261001-01 \
  --note '正在等待已发起的验证任务' --remote run=example-run-id
```

普通 `start` 默认不绑定本地 PID，适合由其他工具执行的远端操作。若确有负责该项工作的长驻本地进程，使用 `--pid PID`；不要填写一个马上退出的 shell PID。不能自动探测的外部任务仍由 20 分钟无进展检查和截止时间覆盖。

## 有超时边界的本地命令

`run` 只运行调用者已经获授权的一条本地命令，执行一次，不经 shell 解析。不会赋予额外权限，也不会突破项目的单一集成负责人规则。每个命令必须给明确 timeout 和唯一 ID：

```sh
python3 tools/progress-watchdog/watchdog.py run \
  --id check-unique-run-id --kind test --timeout 900 -- npm run check
```

- 输出沿用终端；不会把命令参数、环境变量或 stdout/stderr 复制进 journal
- 成功/失败退出写入结果，返回实际子进程退出码（信号退出转为 128+信号）
- 超时采用 monotonic 时钟，不因输出或检查点延长；返回 124
- 超时/中断只向本次新建的子进程组发送 TERM，必要时 KILL；不搜索、接管或终止其他 PID。正常子进程退出后的残留后台任务或主动逃离进程组的任务不由本工具管理；不要包装自我后台化的守护进程
- 退出码为 0 只证明本地命令退出成功，不证明完整游戏验收，也不证明网络副作用已经持久化

对于 `--kind upload`，无论本地命令退出码是否为 0，都保留 `uncertain`，直到从远端只读查询核实。超时、异常或中断也不自动重传。核对既有 commit/run/deployment ID 与预期内容后，先登记 `remote_verified` 检查点，再显式设为成功：

```sh
python3 tools/progress-watchdog/watchdog.py checkpoint upload-unique-id \
  --evidence-id remote-read-unique-id --kind remote_verified \
  --reference 'remote-commit:verified-exact-sha' --summary '只读核对远端提交及预期内容一致'
python3 tools/progress-watchdog/watchdog.py status upload-unique-id \
  --set succeeded --note '远端结果已核实'
```

如果调用的是外部工具而非本地命令，使用 `start --kind upload` **先**登记，附加 `--remote name=value`，再执行用户已授权的动作。watcher 只告警；不会也不能强制给外部工具调用加超时。工具超时后，调用方应标记 `uncertain`，只读核查结果后再决定下一步。

## 状态与告警处理

支持 `running`、`blocked`、`uncertain`、`succeeded`、`failed`、`cancelled`、`timed_out`。例如：

```sh
python3 tools/progress-watchdog/watchdog.py status development-20261001-01 \
  --set blocked --note '等待明确的用户授权，未采取后续动作'
```

blocked/uncertain 立即可见，不等 20 分钟。watcher 发现过期、进程消失或环境变化时，只追加观察告警，不擅自把操作改为 failed。最后的失败/超时仍保持告警，直到负责人已处理并显式确认：

```sh
python3 tools/progress-watchdog/watchdog.py acknowledge check-unique-run-id \
  --note '失败已核实，修复工作登记为另一个操作'
```

acknowledge 保留失败状态及原进展时间；不能清除仍运行、blocked 或 uncertain 的工作。成功、取消的终态不再产生停滞告警。终态不能重开；确需重试必须在得到相应授权、排除不确定远程副作用后登记新的唯一操作。

输出文件：

- `journal.json`：操作的持久真值，观察器只读
- `status.json`：原子更新的最新观察，含检查时间、下一次预期检查时间、观察 PID、警告代码和每项工作的进展/截止信息
- `status.jsonl`：简短观察历史；约 1 MiB 时保留一个 `status.previous.jsonl` 并开始新文件，不清理原操作日志
- `journal.lock`、`report.lock`、`watcher.lock`：进程锁，不代表进展

上层助手读取这些输出并负责用户消息；本工具不自发联络任何人。

## 重启、存储和告警可达性

持久化的 journal 能跨**同一持久工作目录保留的环境重启**继续读取。它不能令临时磁盘永久存在，也不把日志传到远端。工作目录被删除/重建会丢失本地日志；持久目录和备份应由环境提供。

watch 进程本身**不保证跨环境重启、进程被终止或平台休眠存活**，不能在自身停止后报警。重新进入环境时先运行 `once`，查看陈旧状态与进程/环境告警，再启动 `watch`；不要自动重试遗留写入。`status.json` 的检查时间超过两轮应视作观察器可能已停，不可把旧的 healthy 当成当前事实。把 stdout 重定向到文件或让命令后台运行也不能改变此限制。

用户已要求的独立 10 分钟远程进度检查用于环境外的提醒；本实现不另建 automation。它能报告已允许读取的远端状态，不等同于本地 watcher 仍存活，也不会替本地命令恢复执行。若没有外部接收方读取本地状态，本工具只产生本地告警文件。

不得将凭据、令牌、带认证参数的 URL 或其他敏感信息写进 ID、note、summary、reference 或 remote 字段。工具不包含凭据、不读取认证配置；remote 字段拒绝显式凭据名称和带用户信息/查询参数的 URL，但这不是完备的秘密扫描器。运行目录应保持私人，不提交状态日志。

## 验证与限制

回归用例位于 `tests/progress-watchdog/test_watchdog.py`。无第三方测试依赖；测试只使用临时目录、模拟进程证据和短暂的无网络 Python 子进程。由集成负责人串行执行：

```sh
python3 -B -m unittest discover -s tests/progress-watchdog -p 'test_*.py' -v
```

覆盖原子写失败保留旧日志、并发写、20 分钟边界、活动不算进展、证据去重、独立截止时间、时钟倒退、进程退出/僵尸/PID 复用、环境改变、损坏/缺失日志、终态与确认、一次性检查、本地返回码/超时、无关进程保护，以及上传成功仍需远端核实。写好用例不代表已经运行；最终验证结果由集成负责人记录。
