# 交互、表现、保存与发行准备

状态：设计基线 / 待评审；未实现、未执行游戏测试

需求追踪：[REQ-023](../00-overview/requirements.md#req-023)、[REQ-024](../00-overview/requirements.md#req-024)、[REQ-025](../00-overview/requirements.md#req-025)、[REQ-026](../00-overview/requirements.md#req-026)、[REQ-027](../00-overview/requirements.md#req-027)、[REQ-028](../00-overview/requirements.md#req-028)、[REQ-030](../00-overview/requirements.md#req-030)

使命：把复杂因果变得可看懂，同时保存可恢复、浏览器生命周期安全。

拥有：只读投影、面板/焦点/镜头、精灵资源生命周期、存档端口、可见性/标签页协调、素材许可与测量工具。

关键选择：React外部状态订阅局部刷新，Phaser差量同步实体；退管理页恢复镜头/选中/暂停；Canvas提供键盘替代对象列表。

失败策略：存储配额/断写告警并可导出，保留上一成功版本；隐藏标签页停权威推进；监听器和场景在退出时成对释放。

验收：不以截图证明性能，不以内部函数测试替代真实页面实玩；每项结论分目标/未测/通过/失败。

下钻：[保存](../02-detailed-design/10-save-and-recovery.md)、[UI表现](../02-detailed-design/11-ui-rendering.md)、[素材性能](../02-detailed-design/13-assets-performance.md)
