# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Bug Fixes

- **dashboard:** Add @types/node for vite.config.ts in Docker build ([`d0eb92e`](https://github.com/nano-agent-team/nano-agent-team/commit/d0eb92eabb998997c287a257caaea75f90d23cb2))
- **docker:** Correct COPY paths for teams/ and settings frontend-dist ([`c0d4e75`](https://github.com/nano-agent-team/nano-agent-team/commit/c0d4e7586840e0bc41a41297ea68500a269c4095))
- **security:** Remove .env from git, add to .gitignore ([`e964239`](https://github.com/nano-agent-team/nano-agent-team/commit/e9642398e376f6e0d9de8607cfb9f65e8cfb257d))
- Add SSH and persistence support for agent containers ([`d94acde`](https://github.com/nano-agent-team/nano-agent-team/commit/d94acdef40f91a99eb177f2ca379c7d0aadedfd3))
- Address DinD PR review findings ([`ac30370`](https://github.com/nano-agent-team/nano-agent-team/commit/ac303703ac063cebc2621eb3c9c89c15a807a21a))
- **hub:** Support top-level agents/ path and fix plugin-dist location ([`52b8123`](https://github.com/nano-agent-team/nano-agent-team/commit/52b8123c6a3ff44ef6df8d54a44b77ac4c7aecd8))
- Oprav BASE_URL propagaci do vitest workerů, hardcoded URL a TS chybu ([`8893721`](https://github.com/nano-agent-team/nano-agent-team/commit/88937217c16f7c1c0f7ecc8118cc8d9c5079cfc6))
- Use bind mount for data dir instead of named volume ([`0cb01c7`](https://github.com/nano-agent-team/nano-agent-team/commit/0cb01c7dd664246385f9b36929266e14af7fd483))
- **agent-runner:** Catch CONNECTION_CLOSED in heartbeat timer ([`0f61a87`](https://github.com/nano-agent-team/nano-agent-team/commit/0f61a877ec64facac93c34a7cd2f2d46d8833c45))
- **install:** Remove port-blocking container before start (#8) ([`6b64cab`](https://github.com/nano-agent-team/nano-agent-team/commit/6b64cab6d840e5d7437819cc3d8f5a13f512b0b9))
- Start built-in agents after setup completion on fresh install ([`ae0c7bd`](https://github.com/nano-agent-team/nano-agent-team/commit/ae0c7bd2dae4c69f93ffcceef81f1ec2e7d6ad30))
- Ensure NATS consumer exists before starting built-in agents on reload ([`7d54bd3`](https://github.com/nano-agent-team/nano-agent-team/commit/7d54bd3d8eb660436854f892716ef13f29a0a42e))
- Store Claude credentials in data volume, remove host dependency ([`e9a3c63`](https://github.com/nano-agent-team/nano-agent-team/commit/e9a3c6314e4b6efb4c99f97e7ab696cc0f1adf65))
- Claude credentials path for Code 2.x + add login button to Settings ([`8afcc3a`](https://github.com/nano-agent-team/nano-agent-team/commit/8afcc3a2cc51d74b3344677eab1c858b716376d4))
- Persist and mount ~/.claude.json for Claude Code 2.x credentials ([`832314c`](https://github.com/nano-agent-team/nano-agent-team/commit/832314cfd117fa0e15ec8fdb21d289d2f2538a94))
- Native PKCE OAuth flow for Claude — JSON body + state param ([`a0f9f91`](https://github.com/nano-agent-team/nano-agent-team/commit/a0f9f91f457661da1dac7931152b2aff7281e2e5))
- Handle code#state format in Claude OAuth callback ([`8e24b88`](https://github.com/nano-agent-team/nano-agent-team/commit/8e24b881a0bf0cd04eb1bb7b36901cfc667ac1ca))
- Load team plugins on every reloadFeatures call ([`e061fae`](https://github.com/nano-agent-team/nano-agent-team/commit/e061fae1cb8a9e9d1e768355614ac9ccb35740c1))

### Documentation

- **ci:** Update CHANGELOG [skip ci] ([`ab1f505`](https://github.com/nano-agent-team/nano-agent-team/commit/ab1f50512f2b3a6ff34a1396b7c686c084b82147))
- **ci:** Update CHANGELOG [skip ci] ([`8657415`](https://github.com/nano-agent-team/nano-agent-team/commit/8657415788dbd7577e695a49d88ba65dedf4840b))
- **ci:** Update CHANGELOG [skip ci] ([`ac4bbfc`](https://github.com/nano-agent-team/nano-agent-team/commit/ac4bbfc797c8217d9f8f48953af54a7355008891))

### Features

- Initial commit — Faze 4 core infrastructure ([`a8e8a9f`](https://github.com/nano-agent-team/nano-agent-team/commit/a8e8a9f607a50a6fc94b15625ac68a264221bfa6))
- **dashboard:** Migrate Tickets to Module Federation plugin ([`cf696af`](https://github.com/nano-agent-team/nano-agent-team/commit/cf696afa66671dbfd1bb6d8f99116e2884adea18))
- **faze-5:** Installation system (setup mode + settings feature + Docker) ([`078c43f`](https://github.com/nano-agent-team/nano-agent-team/commit/078c43f3a78714b7720b3241e3431405428bb3c1))
- **auth:** Claude Code OAuth login flow in SetupWizard ([`0793bd2`](https://github.com/nano-agent-team/nano-agent-team/commit/0793bd2ab82c0f34a2a7ba08bcc21a6efb81b632))
- **hub:** Dynamic sidebar nav + hub install flow + unified DB ([`c21d1c4`](https://github.com/nano-agent-team/nano-agent-team/commit/c21d1c48ea870ec5abde1c32384a936424082bf5))
- **setup:** Hub catalog install flow + gh CLI in Dockerfile ([`f266154`](https://github.com/nano-agent-team/nano-agent-team/commit/f26615452bc0929ab24a4a4ac864ba9a85e49aaf))
- **observability:** Distributed tracing + log aggregation feature ([`cabe2ae`](https://github.com/nano-agent-team/nano-agent-team/commit/cabe2ae44bed866e458279cb05f75644beff979a))
- Implement multi-provider LLM plugin system ([`41b8d7c`](https://github.com/nano-agent-team/nano-agent-team/commit/41b8d7c3a4a047864e06caa7a10dfe3c410fc111))
- **settings:** Add multi-provider LLM configuration UI ([`9b47f96`](https://github.com/nano-agent-team/nano-agent-team/commit/9b47f963dc54c3163954ca0530d4edd8d1fb9844))
- DinD single-container deployment (nate) (#2) ([`ef1d35d`](https://github.com/nano-agent-team/nano-agent-team/commit/ef1d35d9d989ede56c8ecc23e032224d9af20439))
- **hub:** Include status field in catalog API response ([`587e885`](https://github.com/nano-agent-team/nano-agent-team/commit/587e885f0e7ef199890e08e1522b2fc04898571c))
- Github-team GH_TOKEN passthrough + team agent autostart (#7) ([`f13421d`](https://github.com/nano-agent-team/nano-agent-team/commit/f13421d3534a3e1850bd8b3502f5caf81d115652))
- Add install.sh script ([`f59c6e7`](https://github.com/nano-agent-team/nano-agent-team/commit/f59c6e7ca55676c1b3f16e8dfe2a48ea768a8eac))
- Add reinstall.sh script ([`bf7d205`](https://github.com/nano-agent-team/nano-agent-team/commit/bf7d205391e6333fe5de0a451829a3d0ef169f83))
- **settings/hub:** Branch selector, Update button, connect modal + config preservation (#9) ([`07d4849`](https://github.com/nano-agent-team/nano-agent-team/commit/07d48498bade217f22ee03bbd67c7e58ef90ca1a))
- Agent customization modal (#10) ([`882a77e`](https://github.com/nano-agent-team/nano-agent-team/commit/882a77ea1ba1190334a727367f9c084b935f4ae8))
- OAuth credential proxy + fix built-in agents not starting after setup ([`47f8b42`](https://github.com/nano-agent-team/nano-agent-team/commit/47f8b42c5c02b6723bb4013ab8c3c5f1076f6cab))
- Add --name and --port CLI arguments to install.sh ([`9c0eb03`](https://github.com/nano-agent-team/nano-agent-team/commit/9c0eb03578bf74da406c7778354fe626bb65034f))
- **settings:** Add Claude re-auth UI and restart-agents endpoint (#13) ([`ce3347a`](https://github.com/nano-agent-team/nano-agent-team/commit/ce3347afc7a2204a0e612bd3e076fc6d4eaad71f))
- **settings:** Self-update — check and apply updates from within the app (#12) ([`ed39c2d`](https://github.com/nano-agent-team/nano-agent-team/commit/ed39c2d6b77e8bdb6fa25746992bc22f362be5b3))
- **agent-runner:** Show real-time activity on agent cards (#15) ([`b096198`](https://github.com/nano-agent-team/nano-agent-team/commit/b096198126152e42a699b84766af144ef424d3c1))
- Root agent definitions — shared agents with team fallback (#16) ([`8f18092`](https://github.com/nano-agent-team/nano-agent-team/commit/8f18092d1f235f0deb0fce65cf07b96f2aedd09b))
- **github-team:** Product Owner agent + self-learning for all agents (#17) ([`3b49624`](https://github.com/nano-agent-team/nano-agent-team/commit/3b496247ce6835e936e28ec1f9338ea89481a58c))

### Miscellaneous

- Enforce coding standards — commitlint, husky, English-only (#11) ([`900af92`](https://github.com/nano-agent-team/nano-agent-team/commit/900af929ddcda89d1dbacd7fe021ae386b906106))

### Tests

- Přidej automatické E2E testy (Vitest + Playwright) + GHA workflow ([`3a66c15`](https://github.com/nano-agent-team/nano-agent-team/commit/3a66c156c4df84fc23eaca14c515b3ecb6bfcbee))
- Implementuj B (tickets REST API), C (NATS/SSE), E (MockProvider pipeline) ([`2697a96`](https://github.com/nano-agent-team/nano-agent-team/commit/2697a96cde7462f28cd48313828f063cc0374867))

### Repo

- Add README, LICENSE, CI, and contributing docs (#3) ([`5999e20`](https://github.com/nano-agent-team/nano-agent-team/commit/5999e20acb229dffe559747d241acd3c31b39ff5))


