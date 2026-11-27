# 本项目的浏览器入口

用户要求操作某个环境时，在项目目录运行 `npm run --silent cli -- list --json`，用 `name` 和 `user_id` 定位目标。重名时用 ID 区分。`running` 表示窗口正在运行，`automation` 表示已在环境设置中启用自动化端口。

按需使用 `start <ID>` 打开目标。使用 `connect <ID> --json` 获取当前会话的 `cdpUrl` 和 `cdpPort`，完整命令以 `npm run --silent cli --` 开头。获取地址后，用现有 CDP 客户端连接，核对目标标签页再操作。下次启动时端口可能变化。仅在用户要求关闭环境时使用 `stop <ID>`。

开源客户端示例和错误码见 [README](README.md#接入开源浏览器客户端)。

使用 `--help --json` 可以离线读取命令和参数。用户要恢复误删的环境时，先用 `trash --json` 定位原 ID，再用 `restore <ID> --json`。
