# 文档包校验

仅需要Python 3标准库，从包根运行：

```text
python3 validation/validate.py
```

检查相对Markdown链接与章节锚点、需求/任务ID唯一、任务依赖存在且无环、每项任务包含模块/输入/输出/步骤/验收、31项需求执行覆盖、全部任务planned且验收not_run、冻结源结构和无游戏实现文件。

[report.md](report.md)是本次文档校验结果。它不是游戏测试报告；没有执行游戏构建、性能、可访问或玩法测试。SHA256SUMS可用于校验解压完整性，不含其自身。
