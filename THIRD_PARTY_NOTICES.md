# 第三方许可

电池换班簿的运行时不打包第三方 JavaScript 库、字体、图片、图标或媒体。界面使用系统字体、文本符号和自有 CSS。

开发测试依赖由 `package-lock.json` 固定：

| 依赖 | 用途 | 许可 |
| --- | --- | --- |
| Playwright 1.56.1 | 浏览器端到端验收 | Apache-2.0 |
| playwright-core 1.56.1 | Playwright 浏览器控制 | Apache-2.0 |
| fsevents 2.3.2（仅可选 macOS 依赖） | 上游文件事件 | MIT |

上述依赖不随源码便携包捆绑，开发者通过 `npm ci` 获取。对应许可和 NOTICE 位于安装后各 npm 包目录，并以原包声明为准。

浏览器由用户或 CI 独立安装；Microsoft Edge、Google Chrome、Chromium 的许可属于各自发行版。Windows PowerShell/.NET 为用户系统组件，项目不重新分发它们。
