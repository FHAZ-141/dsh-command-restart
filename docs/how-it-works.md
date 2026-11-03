# 在浏览器里重启 DSH：`/restart` 命令

> `dsh-command-restart` 插件的设计说明与实测记录。
> 英文安装步骤见仓库根目录 `README.md`。

需求：§14.16 的 `dshrestart` 是**本地 PowerShell**，人在外面只有浏览器时就没办法重启。
要的是「在 Web 界面里敲一条命令就能重启 dsh」。

## 1. 为什么不能直接 `systemctl restart`

这条是整件事的核心障碍：

```bash
cat /proc/self/cgroup
# 0::/system.slice/dsh-web.service      ← agent 的 bash 就跑在 dsh-web 的 cgroup 里
systemctl show dsh-web -p KillMode --value
# control-group                          ← 重启会杀掉整个 cgroup
```

所以从 Web 会话里执行 `systemctl restart dsh-web` 等于**自杀**：
命令发出去，进程连同执行它的 shell 一起被杀，用户看到的是页面直接断，没有任何回执。

## 2. 解法：把重启派发到 cgroup 外面

`systemd-run` 创建的 transient unit 挂在 `/system.slice/<unit>.service`，与
`/system.slice/dsh-web.service` **平级**而不是它的子进程，所以 `systemctl restart dsh-web`
杀不到它：

```bash
sudo -n systemd-run --quiet --collect \
  --unit=dsh-restart-<ts> --on-active=3s \
  /bin/systemctl restart dsh-web
```

- `--on-active=3s`：延迟 3 秒，让「即将重启」的回执先送到浏览器
- `--collect`：单元跑完自动回收，不留垃圾
- `--quiet`：不往 stderr 打进度，避免污染命令返回值

**实测**（用等价探针单元 `dsh-probe-sleep` 验证，2026-10-30）：

| 步骤 | 结果 |
| --- | --- |
| `dsh-probe-sleep` 初始 MainPID | 96008 |
| 走插件同一条代码路径排定 2 秒后重启 | `success`，返回 `scheduled by dsh-restart-….timer` |
| 8 秒后 MainPID | **96058**（确实换了进程），`ActiveState=active` |
| 全程主进程未被杀 | ✅ 派发方正常返回 |

## 3. 插件实现

插件放在 profile 目录里，不污染安装目录：

```
~/.dsh/profiles/web/plugins/dsh-command-restart/
├── package.json
└── lib/index.js
```

`package.json` 关键点：

```json
{
  "name": "dsh-command-restart",
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./package.json": "./package.json" },
  "peerDependencies": {
    "@deepseek-ai/dsh-commands": "0.2.1-rc.3",
    "@deepseek-ai/cordis": "~4.0.5"
  }
}
```

> `peerDependencies` 不是为了装包 —— 运行时 DSH 会把安装目录的 `@deepseek-ai/*`
> 通过 ESM resolve hook 映射给 profile 内的插件，**声明出来即可解析**，不用 `pnpm add`。

`lib/index.js` 的导出契约（与官方 `dsh-command-compact` 同构）：

```js
import z from "@deepseek-ai/schemastery";

const name = "command-restart";
const inject = ["commands"];
const Config = z.object({
  unit: z.string().default("dsh-web"),
  defaultDelaySeconds: z.number().default(3)
});

function apply(ctx, config) {
  ctx.effect(function* () {
    yield ctx.commands.register({
      name: "restart",
      description: "Restart the dsh-web service without ending this session",
      input: { hint: "[seconds] | status | cancel" },
      recordInput: false,
      handler
    });
  }, "command-restart lifecycle");
}

export { Config, apply, inject, name };
```

在 `~/.dsh/profiles/web/cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: command-restart
      name: ~/.dsh/profiles/web/plugins/dsh-command-restart/lib/index.js
      config:
        unit: dsh-web
        defaultDelaySeconds: 3
```

> **坑：`name` 必须指到 `.js` 文件本身，不能指目录。**
> 指目录会报 `ERR_UNSUPPORTED_DIR_IMPORT: Directory import '…/dsh-command-restart' is not
> supported resolving ES modules`，服务照常启动但这个条目静默不激活
> （journal 里表现为 `dsh: warning: 2 entries did not activate`，比平时多一条）。
> 因为 `HostResolvedRootInclude` 对绝对路径只做 `pathToFileURL()` 转换，不替你找 `main`。

## 4. 怎么用

在 Web 界面的输入框里直接敲：

| 输入 | 行为 |
| --- | --- |
| `/restart` | 3 秒后重启 dsh-web（默认延迟，够回执送到浏览器） |
| `/restart 10` | 10 秒后重启（1–600 秒），留时间保存正在写的东西 |
| `/restart status` | 只查状态：`dsh-web: active (running), MainPID …, since …` |
| `/restart cancel` | 取消还没触发的重启 |

重启后：**页面会自己重连，不用重新登录。**
cookie 是 30 天有效期的签名 cookie，签名密钥存在 credentials 里跨进程持久
（`dsh-client-connection` 的 `BrowserAuth`，`?token=` 只在首次铸 cookie 时用一次）；
前端重连是 500ms 起步、2 倍退避、上限 10 秒的指数退避。

## 5. 实测记录

| 项目 | 结果 |
| --- | --- |
| `dsh --profile web --dump-config` 里出现条目 | `- id: command-restart` / `name: file:///…/lib/index.js` |
| 首次（指目录）加载 | ❌ `ERR_UNSUPPORTED_DIR_IMPORT`，`2 entries did not activate` |
| 改成指 `lib/index.js` 后 | ✅ `1 entry did not activate`（只剩原有的 inspector 那条） |
| `/restart status` | `dsh-web: active (running), MainPID 93639, since Fri 2026-10-30 18:28:34 HKT` |
| `/restart cancel`（无待办时） | `No pending restart to cancel.` |
| `/restart abc` | 报 usage |
| `/restart 0` / `/restart 999` | 报「延时必须是 1–600 的整数」 |
| 排定 + cancel | 先 `success`，再 `Cancelled dsh-restart-….timer.`，再 `No pending…`（无残留） |
| 探针单元真实重启 | MainPID 96008 → 96058，`active running` |

## 6. 坑

1. **改 `cordis.patch.yml` 会热加载，改插件代码不会**：`dsh-hmr` 只 watch
   profile 的 `package.json` 与两个 `cordis.patch.yml`（`config.root: []` 表示模块根不 watch）。
   改 `lib/index.js` 后必须重启一次才生效，journal 会提示
   `changed modules keep running their previous code until a restart`。
2. **`test -x` 那类命令别忘了 `sudo -n`**：dsh 以 `user` 身份跑，`systemd-run` 需要 root；
   本机 `/etc/sudoers.d` 里已是 `NOPASSWD: ALL`，所以脚本里统一写 `sudo -n`，
   密码提示会直接失败而不是挂住。
3. **重启依然会杀子进程**：`KillMode=control-group`，正在跑的长任务（`dshr` 派发的、
   bash 后台 job）会被一起带走。要等任务跑完再 `/restart`。
4. **不要在重启前一刻改代码**：`Restart=always` + `StartLimitIntervalSec=0` 的组合意味着
   配置写坏会无限重启（§14.16 第一节），届时 `/restart` 也救不回来，得 `systemctl stop`。
5. **`/restart` 与 `/compact` 无关**：命令不产生模型消息（`recordInput: false`），
   不会污染上下文，也不会被 compaction 折叠掉。

## 7. 怎么撤掉

```bash
# 1. 从用户 patch 里删掉那 6 行 - insert: 块
$EDITOR ~/.dsh/profiles/web/cordis.patch.yml
# 2. 可以留着插件目录（不注册就不加载），也可以整个删掉
rm -rf ~/.dsh/profiles/web/plugins/dsh-command-restart
```

改完 patch 会热加载，`/restart` 从命令列表消失，不需要重启。
