# Deploy via GitHub Actions

::: warning Notice
Currently only supports Worker and Pages deployment.
If you encounter any issues, please report them via `GitHub Issues`. Thank you.

The `worker.dev` domain is inaccessible in China, please use a custom domain
:::

## Deployment Steps

### Fork Repository and Enable Actions

- Fork this repository on GitHub
- Open the `Actions` page of the repository
- Make sure the following workflows are enabled:
  - `Deploy Backend`
  - `Deploy Frontend`
  - `Deploy Frontend with Pages Functions` (only needed when you proxy backend requests through Pages Functions)

### Understand How Workflows Trigger

- A push to the `main` branch will trigger deployment automatically
- You can also open `Actions` and click `Run workflow` to deploy manually
- If your default branch is not `main`, update the `branches` setting in each workflow first

### Configure Secrets

Then go to the repository page `Settings` -> `Secrets and variables` -> `Actions` -> `Repository secrets`, and add the following `secrets`:

- Common `secrets`

   | Name                    | Description                                                                                                            |
   | ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
   | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID, [Reference Documentation](https://developers.cloudflare.com/workers/wrangler/ci-cd/#cloudflare-account-id) |
   | `CLOUDFLARE_API_TOKEN`  | Cloudflare API Token, [Reference Documentation](https://developers.cloudflare.com/workers/wrangler/ci-cd/#api-token)           |

- Worker backend `secrets`

   | Name                           | Description                                                                                                                                    |
   | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
   | `BACKEND_TOML`                 | Backend configuration file. Copy `worker/wrangler.toml.template`, then adjust it for your own account. You can also refer to the [Worker configuration guide](/en/guide/cli/worker.html#modify-wrangler-toml-configuration-file) |
   | `BACKEND_USE_MAIL_WASM_PARSER` | (Optional) Whether to use WASM to parse emails, set to `true` to enable. For features, refer to [Configure Worker to use WASM Email Parser](/en/guide/feature/mail_parser_wasm_worker) |
   | `USE_WORKER_ASSETS`            | (Optional) Bundle frontend static assets into the Worker deployment, set to `true` to enable                                                  |
   | `USE_WORKER_ASSETS_WITH_TELEGRAM` | (Optional) Use together with `USE_WORKER_ASSETS` to build the Telegram Mini App frontend bundle, set to `true` to enable                    |

- Pages frontend `secrets`

   > [!warning] Notice
   > If you deploy the frontend as Worker assets, you usually do not need a separate Pages frontend deployment.

   | Name               | Description                                                                                                                                                                      |
   | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `FRONTEND_ENV`     | Frontend configuration file, please copy the content from `frontend/.env.example`, [and modify according to this guide](/en/guide/cli/pages.html)                               |
   | `FRONTEND_NAME`    | The project name you created in Cloudflare Pages, can be created via [UI](https://temp-mail-docs.awsl.uk/en/guide/ui/pages.html) or [Command Line](https://temp-mail-docs.awsl.uk/en/guide/cli/pages.html) |
   | `FRONTEND_BRANCH`  | (Optional) Branch for pages deployment, can be left unconfigured, defaults to `production`                                                                                      |
   | `TG_FRONTEND_NAME` | (Optional) The project name you created in Cloudflare Pages, same as `FRONTEND_NAME`. Fill this in if you need Telegram Mini App functionality                                  |

- Pages Functions `secrets`

   | Name        | Description                                                                                                                                          |
   | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `PAGE_TOML` | Required when using Pages Functions to forward backend requests. Copy `pages/wrangler.toml` and modify the `name` and `service` fields for your own Pages project and Worker service. If your backend Worker does not use a named environment, do not add an `environment` field |

   If your Pages project already has bindings configured in the Cloudflare dashboard, run `wrangler pages download config <your-project-name>` first and then convert that output into `PAGE_TOML` to avoid drift between dashboard settings and repository config.

### What Each Workflow Does

- `Deploy Backend`
  Deploys `worker/` to Cloudflare Workers.
- `Deploy Frontend`
  Deploys `frontend/` directly to Cloudflare Pages. Use this for a separated frontend/backend setup.
- `Deploy Frontend with Pages Functions`
  Builds the frontend with `frontend/.env.pages`, then deploys `pages/` so the frontend and API can run under the same Pages project.

### Deploy

- Recommended: push your changes to `main`, and GitHub Actions will deploy automatically
- Manual: open `Actions`, choose the target workflow, then click `Run workflow`

## How to Configure Auto-Update

1. Open the `Actions` page of the repository, find `Upstream Sync`, and click `enable workflow`
2. Once `Upstream Sync` updates your `main` branch, the deployment workflows above will run automatically
3. If `Upstream Sync` fails, go to the repository homepage and click `Sync` to synchronize manually
