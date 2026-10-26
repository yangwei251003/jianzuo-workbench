# 依赖状态 · 2026-10-26

已在同主版本兼容范围修补Sharp0.35.5、Fastify5.12.6、fast-uri3.1.9/4.2.3、brace-expansion5.0.12、Vitest4.1.12、Vite8.2.4、shell-quote1.11.0、source-map-js1.2.2、undici7.30.1和Electron44.9.1，并重新执行类型检查、构建、173原单元测试和33原浏览器测试。

生产及完整依赖审计各剩1条moderate，0high/critical；不宣称审计清零或生产安全。保留项是worker→node-notifier10.0.1→uuid8.3.2：[上游公告](https://github.com/advisories/GHSA-w5hq-g745-h8pq)。公告涉及v3/v5/v6函数向外部缓冲区写入的边界校验。当前已安装node-notifier的toaster只导入v4并无参数生成管道名；据此推断此通知调用路径不触及公告中的函数，不代表未来所有用法都安全。没有为清零而强推不兼容uuid大版本，后续跟进通知库升级。

依赖缓存与Electron二进制没有随源码分发。本轮使用ignore-scripts安装并验证API/Web/模拟适配；没有重新运行native Electron桌面壳，也没有验证真实账号、模型生成或任何真实发布/回复/交付。
