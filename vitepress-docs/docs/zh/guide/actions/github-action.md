# 通过 Github Actions 部署

::: warning 注意
目前只支持 worker 和 pages 的部署。
有问题请通过 `Github Issues` 反馈，感谢。

`worker.dev` 域名在中国无法访问，请自定义域名
:::

## 部署步骤

### Fork 仓库并启用 Actions

- 在 GitHub fork 本仓库
- 打开仓库的 `Actions` 页面
- 确认以下工作流已启用：
  - `Deploy Backend`
  - `Deploy Frontend`
  - `Deploy Frontend with Pages Functions`（仅在你使用 Pages Functions 代理后端时需要）

### 了解工作流触发方式

- 推送到 `main` 分支后会自动部署
- 也可以在 `Actions` 页面里手动点击 `Run workflow` 单独部署
- 如果你的默认分支不是 `main`，请先修改对应 workflow 中的 `branches`

### 配置 Secrets

然后在仓库页面 `Settings` -> `Secrets and variables` -> `Actions` -> `Repository secrets`, 添加以下 `secrets`:

- 公共 `secrets`

   | 名称                    | 说明                                                                                                            |
   | ----------------------- | --------------------------------------------------------------------------------------------------------------- |
   | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账户 ID, [参考文档](https://developers.cloudflare.com/workers/wrangler/ci-cd/#cloudflare-account-id) |
   | `CLOUDFLARE_API_TOKEN`  | Cloudflare API Token, [参考文档](https://developers.cloudflare.com/workers/wrangler/ci-cd/#api-token)           |

- worker 后端 `secrets`

   | 名称                           | 说明                                                                                                                                    |
   | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
   | `BACKEND_TOML`                 | 后端配置文件，请复制 `worker/wrangler.toml.template` 的内容后按需修改，也可参考 [worker 配置文档](/zh/guide/cli/worker.html#修改-wrangler-toml-配置文件) |
   | `BACKEND_USE_MAIL_WASM_PARSER` | (可选) 是否使用 wasm 解析邮件，配置为 `true` 开启, 功能参考 [配置 worker 使用 wasm 解析邮件](/zh/guide/feature/mail_parser_wasm_worker) |
   | `USE_WORKER_ASSETS`            | (可选) 将前端静态资源一并打进 Worker 部署，配置为 `true` 开启                                                                            |
   | `USE_WORKER_ASSETS_WITH_TELEGRAM` | (可选) 与 `USE_WORKER_ASSETS` 配合使用，构建 Telegram Mini App 版本的前端资源，配置为 `true` 开启                                     |

- pages 前端 `secrets`

   > [!warning] 注意
   > 如果选择部署带有前端资源的 Worker，则通常不需要再配置独立前端部署。

   | 名称               | 说明                                                                                                                                                                                      |
   | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `FRONTEND_ENV`     | 前端配置文件，请复制 `frontend/.env.example` 的内容，[并参考此处修改](/zh/guide/cli/pages.html)                                                                                           |
   | `FRONTEND_NAME`    | 你在 Cloudflare Pages 创建的项目名称，可通过 [用户界面](https://temp-mail-docs.awsl.uk/zh/guide/ui/pages.html) 或者 [命令行](https://temp-mail-docs.awsl.uk/zh/guide/cli/pages.html) 创建 |
   | `FRONTEND_BRANCH`  | (可选) pages 部署的分支，可不配置，默认 `production`                                                                                                                                      |
   | `TG_FRONTEND_NAME` | (可选) 你在 Cloudflare Pages 创建的项目名称，同 `FRONTEND_NAME`，如果需要 Telegram Mini App 功能，请填写                                                                                  |

- Pages Functions `secrets`

   | 名称        | 说明                                                                                                                                                      |
   | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `PAGE_TOML` | 使用 Pages Functions 转发后端请求时需要配置，请复制 `pages/wrangler.toml` 的内容，并根据实际情况修改 `name` 和 `service` 字段为你自己的 Pages/Worker 名称；如果后端 Worker 没有使用命名环境，就不要额外填写 `environment` |

   如果你的 Pages 项目已经在 Cloudflare Dashboard 中配置过绑定，建议先执行 `wrangler pages download config <你的项目名>` 导出现有配置，再整理成 `PAGE_TOML`，避免 Dashboard 配置与仓库配置不一致。

### 三套工作流分别做什么

- `Deploy Backend`
  将 `worker/` 部署到 Cloudflare Workers。
- `Deploy Frontend`
  将 `frontend/` 直接部署到 Cloudflare Pages，适合前后端分离部署。
- `Deploy Frontend with Pages Functions`
  先用 `frontend/.env.pages` 构建前端，再用 `pages/` 中的 Functions 代理后端请求，适合同域部署。

### 部署

- 推荐方式：将配置提交到 `main`，GitHub Actions 会自动部署
- 手动方式：打开 `Actions` 页面，选择对应 workflow 后点击 `Run workflow`

## 如何配置自动更新

1. 打开仓库的 `Actions` 页面，找到 `Upstream Sync`，点击 `enable workflow` 启用 `workflow`
2. 当 `Upstream Sync` 将上游更新同步到你的 `main` 分支后，会自动触发上面的部署工作流
3. 如果 `Upstream Sync` 运行失败，到仓库主页点击 `Sync` 手动同步即可
