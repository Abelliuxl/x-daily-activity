# X Daily Activity

一个 Tampermonkey 用户脚本，在 X 页面右上角显示当天的：

- **主动发帖**：你发布的非回复帖子（包括引用帖，不包括转发）
- **回复**：你回复其他帖子的数量

统计按浏览器的本地时区分天。浮窗每次加载都默认位于右上角，当前页面内可自由拖动。

## 安装

1. 先安装 [Tampermonkey](https://www.tampermonkey.net/)。
2. [点击这里安装脚本](https://raw.githubusercontent.com/Abelliuxl/x-daily-activity/main/x-daily-activity.user.js)。
3. 打开已登录的 [X](https://x.com/)，等待浮窗显示“已同步”。

## 更新和测试

- Tampermonkey 会根据脚本里的 `@updateURL` 检查 GitHub 上的新版本。
- 每次推送新代码时，需同时增加 `@version`，然后在 Tampermonkey 中点“检查更新”。
- 也可以再次点击上面的安装链接，立即覆盖安装 GitHub `main` 分支上的版本。

## 工作方式

脚本在已登录的 X 页面内运行：

1. 定时同步当前账号的“帖子和回复”时间线，遇到今天之前的帖子后停止翻页。
2. 监听 X 页面自己的网络响应，新发帖、新回复或删除帖子后会立即更新。
3. 按帖子 ID 去重，统计结果仅保存在 Tampermonkey 本地存储中，并自动清理 7 天以前的数据。

浮窗右上角的 `↻` 可手动重新同步。

## 注意

- 脚本不使用第三方服务器，不上传 Cookie、帖子内容或统计结果。
- 由于同步依赖 X Web 当前使用的接口，X 大幅改版后可能需要更新脚本。脚本会从 X 当前加载的主程序动态读取接口版本，尽量降低失效概率。
- 默认最多同步 10 页（通常约 400 条）。如果当天超过这个数量，状态栏会提示只已同步前 10 页。

## 本地校验

```bash
npm test
```

## License

[MIT](LICENSE)
