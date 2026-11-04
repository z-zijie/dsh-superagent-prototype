---
name: dsh-superagent-gitcode
description: Work on GitCode issues, pull requests, review discussions and CI using gc.
---

The GitCode Source watches `$DSH_SUPERAGENT_GITCODE_REPOSITORY` from the execution environment section. Use `gc` for every GitCode operation, always with `--no-interactive` and `-R $DSH_SUPERAGENT_GITCODE_REPOSITORY` (or an explicit `repos/<owner>/<repo>/…` path for `gc api`). Never use another account, token or the web UI. `gc` acts as `$DSH_SUPERAGENT_GITCODE_ACCOUNT`.

GitCode numbers Issues and pull requests separately: thread `gitcode:issue:<n>` is Issue n and `gitcode:pr:<n>` is PR n; on GitCode a PR is written `!n` and its page is `…/merge_requests/<n>`. `$DSH_SUPERAGENT_GITCODE_KIND` says whether `$DSH_SUPERAGENT_GITCODE_NUMBER` is an issue or a pr.

**The account may be a person's own.** Everything the agent posts appears under the same name as that person, so:

- Begin every Issue, comment, review reply and PR description you write on GitCode with the disclosure line the Communication section names, so readers can tell your posts from the person's.
- Only what starts `@<account> <keyword>` (such as `@zhangzijie superagent, review this PR`) is addressed to the agent. Never begin a post of your own that way, and never quote such a line at the start of a post: the Source would take it as a new request.
- The account's other posts are not delivered to you; read the thread when you need them.

Reading, beyond the thread context delivered with each trigger:

- `gc issue view <n> -R …`, `gc issue comments <n> -R …`; `gc pr view <n> -R …`, `gc pr comments <n> -R …` (code comments carry a DiscussionID), `gc pr diff <n> -R …`.
- `gc api repos/<owner>/<repo>/pulls/<n>/files`, `…/pulls/<n>/commits`, and any other read of the GitCode API v5.
- CI is GitCode Actions: `gc api '/api/v8/repos/<owner>/<repo>/actions/runs?branch=<branch>'`, then `…/actions/runs/<run-id>/jobs` and `…/jobs/<job-id>/logs`.

Writing:

- The host posts acknowledgements and replies in the source conversation; do not repeat them with `gc`.
- Answer a code comment in its review discussion: `gc pr reply <n> --discussion <DiscussionID> --body <text> -R …`. Use `gc pr comment <n>` for the conversation, and `--path`/`--position` for a new code comment.
- Work in the ticket directory; push with plain `git push` over https, which takes its gitcode.com credentials from gc. Open a PR from a branch whose last path segment is `$DSH_SUPERAGENT_NAME`: `gc pr create -R … --head <branch> --base <default branch> --title … --body …`. A PR that started the ticket is fetched as `$DSH_SUPERAGENT_GITCODE_PR_HEAD`.
- Commit as the author the Delivery requirements section names, otherwise as `$DSH_SUPERAGENT_GITCODE_ACCOUNT` <`$DSH_SUPERAGENT_GITCODE_COMMIT_EMAIL`>.
- Immediately after creating or adopting the ticket's PR, call `orchestrator_report` with `state: progress` and `pr_number`: for a ticket that started on GitCode it names the GitCode PR. The host then follows the PR: its comments, its CI changes, and its merge or close, which ends the ticket.
- Never merge a PR, close an Issue, or change repository settings unless the Delivery requirements section says so.
