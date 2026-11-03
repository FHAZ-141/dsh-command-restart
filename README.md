# dsh-command-restart

A DSH plugin that adds a `/restart` command, so you can restart the DSH web
service **from inside a browser session** — no SSH, no local script.

```text
/restart          restart after 3s (enough time for the reply to reach the browser)
/restart 10       restart after 10s
/restart status   show ActiveState / SubState / MainPID / start time
/restart cancel   cancel a pending restart
```

After the restart the page reconnects by itself. You stay logged in: the auth
cookie is signed with a key persisted in `DSH_HOME`, so it survives the process.

## Why a plain `systemctl restart` does not work

DSH runs as a systemd service with `KillMode=control-group`, and the agent's
shell runs **inside that same cgroup**:

```console
$ cat /proc/self/cgroup
0::/system.slice/dsh-web.service
$ systemctl show dsh-web -p KillMode --value
control-group
```

So `systemctl restart dsh-web` issued from a Web session kills the process that
issued it. The page drops, and the user gets no acknowledgement.

The fix is to hand the restart to a *transient* unit, which systemd places beside
`dsh-web.service` rather than inside it:

```console
$ sudo systemd-run --quiet --collect \
    --unit=dsh-restart-<ts> --on-active=3s \
    /bin/systemctl restart dsh-web
```

`--on-active=3s` gives the command reply time to reach the browser; `--collect`
lets the transient unit be garbage-collected once it has run.

## Install

1. Copy the plugin somewhere under your DSH profile, e.g.

   ```console
   mkdir -p ~/.dsh/profiles/web/plugins/dsh-command-restart/lib
   cp package.json ~/.dsh/profiles/web/plugins/dsh-command-restart/
   cp lib/index.js  ~/.dsh/profiles/web/plugins/dsh-command-restart/lib/
   ```

2. Append to `~/.dsh/profiles/web/cordis.patch.yml`:

   ```yaml
   - insert:
       - id: command-restart
         name: /home/you/.dsh/profiles/web/plugins/dsh-command-restart/lib/index.js
         config:
           unit: dsh-web
           defaultDelaySeconds: 3
   ```

   Point `name` at the **`.js` file**, not at the directory — see the pitfalls
   below.

3. Make sure the invoking user can run `systemd-run` without a password
   (a `NOPASSWD` sudoers rule, or equivalent). The plugin always calls
   `sudo -n`, so a password prompt fails fast instead of hanging.

4. Restart the service once so the new module is imported. Editing
   `cordis.patch.yml` is hot-reloaded, but **module code is not** — DSH watches
   the profile manifest and patch files, not module roots.

No `pnpm add` is needed: DSH maps the installation's `@deepseek-ai/*` packages
into profile-local plugins through an ESM resolve hook, so declaring them in
`peerDependencies` is enough.

## Configuration

| key | default | meaning |
| --- | --- | --- |
| `unit` | `dsh-web` | systemd unit that serves the Web UI |
| `defaultDelaySeconds` | `3` | delay used when `/restart` is given no argument |

Delay is clamped to 1–600 seconds.

## Pitfalls

1. **`name` must point at the file, not the directory.** A directory import
   fails with `ERR_UNSUPPORTED_DIR_IMPORT`, and the service still starts — the
   only trace is a `did not activate` line in the journal:

   ```text
   dsh: warning: N entries did not activate
   ```

   DSH's absolute-path handling only runs `pathToFileURL()`; it does not consult
   `package.json` `main`/`exports` for you.

2. **The restart still kills child processes.** `KillMode=control-group` means
   any long-running task spawned by the agent is taken down with the service.
   Wait for it to finish before restarting.

3. **Do not edit configuration right before a restart.** With
   `Restart=always` and `StartLimitIntervalSec=0`, a broken config leads to an
   infinite restart loop, and `/restart` will not rescue you — use
   `systemctl stop` first.

4. **This command is not a conversation turn.** It registers with
   `recordInput: false`, so it produces no model message and is never folded
   into compaction.

5. **Cancel uses `sudo -n systemctl stop <timer>`**, which removes the pending
   timer unit. Restarting the service out-of-band leaves no timer behind
   anyway, because transient units are collected.

## Removing it

Delete the `- insert:` block from `cordis.patch.yml` (hot-reloaded; `/restart`
disappears from the command list immediately), then optionally delete the plugin
directory.

## Compatibility

Written against DSH `0.2.1-rc.3` (`@deepseek-ai/dsh-commands`,
`@deepseek-ai/cordis ~4.0.5`, `@deepseek-ai/schemastery`). It uses only the
documented `ctx.commands.register` contract, so it should track that contract
rather than any single release.

## License

MIT
