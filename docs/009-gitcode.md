# 009 Enabling GitCode on a running installation

Instructions for an agent that operates a running dsh-superagent and adds the GitCode Source to it, as a hot update: DSH keeps running, and so do the GitHub and Feishu Sources. Read [006 Deployment](006-deployment.md) for the parts this links to; this document adds only what differs on a running installation.

What the GitCode Source does is described in the GitCode sections of [006 Deployment](006-deployment.md) and in `skills/dsh-superagent-gitcode/SKILL.md`. In short: it polls one gitcode.com repository through the `gc` CLI. The agent may share a person's own account: only an Issue, PR or comment that starts `@<account> <keyword>` (default keyword `superagent`) is addressed to it.

## What reloads without a restart

Verified on DSH 0.2.1-rc.3:

| Change | Takes effect |
| --- | --- |
| An edit of the profile's `cordis.patch.yml` that adds, enables or disables an entry | Live: DSH recomposes the profile, the process keeps its PID |
| A settings save that returns `restarting: true` | dsh-superagent restarts inside the DSH process, which keeps running |
| Rebuilt plugin code (`pnpm build` rewriting `lib/`) | Live only when the profile's `hmr` entry watched `<checkout>/lib` when DSH last started; otherwise at the next restart |

This release changes the main plugin as well as adding the GitCode one, so the new code must load before the GitCode entry is enabled. An installation without the `hmr` watch therefore needs one restart, in step 3; every later update is hot.

Each reload of dsh-superagent runs setup again. A running Assignment ends and its ticket restarts it with recovery notes, as after any restart (Upgrade in [006 Deployment](006-deployment.md)).

## Steps

Run every command from the installation's checkout. `$api` is `http://127.0.0.1:<port>/orchestrator/api`, called with the header `x-orchestrator-request: 1` (Management API in [006 Deployment](006-deployment.md)).

### 1. Prepare the GitCode account

Install GitCode CLI 0.15 or later, sign it in, and write the `gc` wrapper of GitCode account in [006 Deployment](006-deployment.md). Setup and worker shells drop `GITCODE_TOKEN`, so the wrapper finds the token itself and answers git's credential requests. If the person does not want a token stored, stop here and ask them; this is an operator step.

Done when `env -u GITCODE_TOKEN -u GC_TOKEN <wrapper> --no-interactive api user` prints the account's JSON, with its `login`.

### 2. Update the code

1. Wait until no Executor is in the middle of a turn (`GET $api/state`: `load.running` is 0, or the person accepts the interruption).
2. Back up `<stateDir>/orchestrator.sqlite`.
3. `git pull && pnpm install && pnpm build`.

Done when `lib/gitcode-watch.js` exists and `pnpm typecheck` passes.

### 3. Load the new code and enable the Source

Read the profile's `cordis.patch.yml` (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`). Then follow the branch that matches it.

**The `hmr` entry already lists `<checkout>/lib` under `root`.** The build in step 2 reloaded dsh-superagent: `health.runtime.at` from `GET $api/state` is later than the build. Append the GitCode entry; it loads live:

```yaml
- id: dsh-superagent-gitcode
  disabled: false
```

**Otherwise,** append the GitCode entry and the `hmr` watch together, then restart once with `scripts/dsh-superagent --profile <profile> restart`:

```yaml
- id: dsh-superagent-gitcode
  disabled: false
# Hot update: reload dsh-superagent when `pnpm build` rewrites lib/ (from the next start).
- id: hmr
  config:
    root:
      - <absolute checkout path>/lib
```

Keep every other entry of the file as it is; DSH's own panels write entries there too.

Done when `GET $api/settings` lists a Source with `id` `gitcode` and `installed: true`, and `GET $api/state` shows no `setup.problem`. A setup problem whose output names a network timeout, such as `TLS handshake timeout`, clears with `POST $api/setup/check`.

### 4. Save the settings

Save each block with `PUT $api/settings/<block>`, reading its current `revision` from `GET $api/settings` first. A save that answers `restarting: true` restarts dsh-superagent: wait until `GET $api/state` answers again before the next request.

1. `source:gitcode`: `{"enabled": true, "config": {"repository": "<owner>/<name>", "cli": "<absolute wrapper path>", "keyword": "superagent"}}`. Ask the person for the repository and keyword when they have not named them.
2. `policy`: the current value with `sources.gitcode.allowed` set to the GitCode logins that may ask for work, such as `[{"id": "<login>"}]`. Keep every other key as read.
3. `executor`: the current value with a `prepare` that checks out the GitCode repository for a ticket that started there. It is a shell command; `$DSH_SUPERAGENT_GITCODE_NUMBER` is set only for such a ticket:

   ```sh
   if [ -n "$DSH_SUPERAGENT_GITCODE_NUMBER" ]; then
     repo=<GitCode clone>; url="https://gitcode.com/$DSH_SUPERAGENT_GITCODE_REPOSITORY.git"; head="${DSH_SUPERAGENT_GITCODE_PR_HEAD:-HEAD}"
   else
     repo=<GitHub clone>; url="https://github.com/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git"; head="${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}"
   fi
   git -C "$repo" fetch --no-tags "$url" "$head:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET" &&
   git -C "$repo" worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"
   ```

   Clone the GitCode repository first if no clone exists, with `git clone https://gitcode.com/<owner>/<name>.git`.

Done when `health.gitcode` in `GET $api/state` is `ready` with the detail `<owner>/<name> as @<login>`, and `setup.problem` is null.

### 5. Verify

From an allowed account, post a comment on an Issue of the repository that starts `@<account> <keyword>, ` followed by a small request. Within about a minute, `GET $api/sources` counts it as received for `gitcode`, and the agent's acknowledgement appears under the comment.

Done when the acknowledgement is on GitCode. Then tell the person, in one message: the keyword rule, that the agent starts its GitCode posts with the disclosure line, and that later updates are hot (`git pull && pnpm install && pnpm build`).

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `health.gitcode` is `error`: `The GitCode Source has no working gc CLI` | Setup left GitCode out; `setup` in `GET $api/state` or the log names why. Fix the wrapper or repository, then `POST $api/setup/check` |
| A post is not received | It must start with `@<account> <keyword>`; the account's other posts, and anything the Source posted itself, are skipped. Check the author is on `sources.gitcode.allowed` |
| `scripts/dsh-superagent status` exits 1 with `health: null` while the panel works | A checkout before the proxy fix: on macOS, Python sends loopback requests through the system proxy. Update the checkout |
| A rebuild did not reload | The `hmr` watch was added after DSH started; restart once |
