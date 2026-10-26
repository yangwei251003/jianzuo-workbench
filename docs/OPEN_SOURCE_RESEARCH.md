> 原开发说明快照，实际公开副本的运行与验证范围以仓库根README和docs/VERIFICATION.json为准；历史真实账号状态不属于本次验证。

# 闲鱼相关开源项目研究记录

复核日期：2026-08-31

这些仓库只作为只读研究来源，不作为依赖或代码来源。许可证结论来自仓库当日 GitHub 页面；仓库以后变更时必须重新复核。

| 仓库 | 当日许可证/限制 | 可借鉴思想 | 本项目边界 |
|---|---|---|---|
| [Usagi-org/ai-goofish-monitor](https://github.com/Usagi-org/ai-goofish-monitor) | MIT；仓库已归档 | 任务历史、通知、监控面板 | 不复制 Cookie 登录态导入、代理轮换或反检测实现 |
| [shaxiu/XianyuAutoAgent](https://github.com/shaxiu/XianyuAutoAgent) | GPL-3.0 | 规则优先、客服路由、专长分工 | 不复制 GPL 代码，不接入 Cookie 或私有连接 |
| [zhinianboke/xianyu-auto-reply](https://github.com/zhinianboke/xianyu-auto-reply) | AGPL-3.0；README 另有禁止商业用途说明 | 状态机、自动交付模块边界 | 许可证与商业用途限制均不适合本商品，禁止复制或作为运行依赖 |
| [DropsDevopsOrg/ECommerceCrawlers](https://github.com/DropsDevopsOrg/ECommerceCrawlers) | MIT；仓库说明包含成员/客户项目汇编 | 去重、计划任务、通知 | 只研究通用思想，不复制旧闲鱼爬虫或来源边界不清的子项目 |
| [GuDong2003/xianyu-auto-reply-fix](https://github.com/GuDong2003/xianyu-auto-reply-fix) | AGPL-3.0 | 事件分发、日志脱敏 | 不复制 AGPL 代码、私有协议或验证码相关实现 |
| [cv-cat/XianYuApis](https://github.com/cv-cat/XianYuApis) | GitHub 页面未显示许可证 | 仅用于识别私有协议风险面 | 无许可证且定位为逆向 API，禁止复制、依赖或接入 |
| [Christ9038/Ydisks-Xianyu-Helper](https://github.com/Christ9038/Ydisks-Xianyu-Helper) | Apache-2.0；README 明示调用非公开接口可能违反平台条款 | 持久 Outbox、租约、未知结果、SSRF 防护 | 只独立实现通用安全模式，不复制其私有接口或可能违反平台条款的实现 |

许可闸门：MIT、Apache-2.0、BSD 可在保留声明后评估；GPL 需履行完整义务；AGPL、非商业、无许可证默认禁止进入可发布商品。
