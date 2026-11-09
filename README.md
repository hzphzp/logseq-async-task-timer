# Logseq Async Task Timer

给异步任务安排下一次跟进，保留每次检查、延后和结束提醒的记录。

**v2.1.10** · [发布说明](docs/releases/v2.1.10.md) · [下载安装包](https://github.com/hzphzp/logseq-async-task-timer/releases/tag/v2.1.10) · [English](#english)

> [!IMPORTANT]
> **v2.1.10 仅支持 Logseq 2.0.2 起的 2.x 数据库图谱（DB graphs）。**
> Logseq 2.0.0 / 2.0.1、0.x 和文件图谱均不受支持；3.x 也未开放支持。
> 本项目已停止旧版适配。仍在使用旧版 Logseq 或文件图谱的用户，请保留
> [v1.6.7](https://github.com/hzphzp/logseq-async-task-timer/releases/tag/v1.6.7)，不要安装本次更新。

插件版本 **2.1.10** 与 Logseq 客户端版本 **2.0.2** 是两个独立版本号。
运行时接受的客户端范围为 `>= 2.0.2, < 3.0.0`，且必须是数据库图谱；
实际验证的客户端为 **Logseq Desktop 2.0.2，revision `533ac43`**，未逐一验证其他 2.x 版本。

自 v2.1.2 起，插件采用数据库原生属性保存提醒，增加暂停、恢复、历史、撤销、项目筛选和批量跟进，
并保留任务原有状态。还修复了数据库尚未就绪时的启动报错，以及标题显示为内部 `[[UUID]]` 的问题。
完整变更见 [v2.1.2 发布说明](docs/releases/v2.1.2.md)。

「已到期」按到期时间从近到远排列；今天和以后的任务按最早截止时间在前排列。面板打开期间，新到期的任务会自动移到「已到期」顶部。

## v2.1.8 跟进与连续处理

已有提醒点「跟进」即可输入或选预设。完成一项任务期间，可以继续处理面板里的其他任务。同一块出现在多个位置时，各处都显示保存进度。新的任务仍须先读取，所有写入仍会核对当前数据库；遇到另一台设备的修改时，插件会保留草稿并提示核对。

## v2.1.6 点击标题定位原任务

点击面板里的任务标题，直接打开原任务块及其子块，可通过 Logseq 的面包屑返回所属页面或日志。修复旧滚动接口只打开日志页、未能定位具体块的问题；不依赖父块是否展开。块已删除或跳转失败时保留面板并提示，关闭面板或切换图谱后不再执行尚未发出的跳转。

继续仅支持 **Logseq >= 2.0.2, < 3.0.0 的 DB 图谱**；无需迁移数据，不修改任务状态或提醒时间。

## v2.1.5 点击响应与保存性能

正文中的「跟进」先打开设置窗口，再读取当前任务；工具栏面板先显示已有列表，再后台核对。读取期间会显示进度并暂时禁用保存，避免用过期状态提交。

「完成」和保存跟进时间不再在前后扫描全部提醒。写入并核验成功后直接更新当前记录；晚到的旧扫描不会覆盖新状态。标题链接只在展示时解析，属性定义一次查询，减少与 Logseq 的往返调用。保存时显示「保存中…」，同一内联按钮的连续点击只执行一次操作。

保存校验、跨设备冲突检查、任务原生状态、撤销历史及超时后不重复写入的规则保留。后台仍会核对其他设备的更改。本版本继续仅支持 **Logseq >= 2.0.2, < 3.0.0 的 DB 图谱**，无需迁移数据；替换插件后重载生效。

## v2.1.4 首次完成与保存校验

直接完成一个尚无插件提醒历史的原生任务时，现在会同时保存 Logseq 原生 Done 状态和首条完成记录，避免错误提示“保存校验失败”。撤销可恢复原来的任务状态。保存与撤销校验先规范化字段，属性键的排列顺序不会造成误判。

## v2.1.3 连接恢复

遇到 Logseq 插件通信层的 `[deferred timeout] async call #…` 时，插件保留上次读取的提醒列表，并按 1.5、3、10、30 秒逐步延长间隔重新连接，不再连续弹出原始超时错误。该版本恢复后会重新读取真实记录。当前版本对断线期间到期的任务按下文的十分钟时限处理。

保存时超时可能只是响应丢失。插件不会自动重发写入或执行排队的后续修改，而是重新读取结果后提示核对。批量导入／同步引发的后台刷新最多每 5 秒启动一次；到期检查与手动刷新保持即时。

## 快速使用

1. 在任务块输入 `/异步任务计时` 或 `/Async Timer`，也可右键选择「设置异步提醒」。
2. 选择分钟数、明天 09:00、下个工作日 09:00，或指定日期和时间。
3. 可填写负责人和项目；设置提醒保留原来的 Todo / Doing 等任务状态。
4. 点击工具栏时钟查看「下一次跟进」面板，可搜索、按项目筛选、选择任务并批量延后。
5. 到期后检查任务进展，再选择下一次跟进时间或结束提醒。

所有时间按本机时区输入和显示，数据库保存 Unix 毫秒时间戳。
「下个工作日」指从明天开始的下一个周一至周五，不包含节假日表。
分钟预设与批量「1 小时后」均从操作时刻开始计算。

## 提醒与任务状态

- **跟进 / 改时间**：重新安排提醒，保留原任务状态，记录最近检查时间。
- **暂停**：保存剩余时长、停止提醒；恢复时从剩余时长继续计时。
- **取消提醒**：提醒进入历史，任务状态保持不变。
- **完成任务**：设置 Logseq 原生 `Done`，提醒进入历史。
- **撤销上一步**：恢复该提醒最近一次操作之前的时间、提醒状态和任务状态，并追加撤销记录。
- **只保存负责人 / 项目**：更新原生属性，不改提醒时间和任务状态。

暂停、取消和完成都保留历史，不删除任务。可在「历史」页重新设置已取消的提醒。
原生任务已为 `Done` / `Canceled` 时，插件停止提醒；要重新跟进，先在 Logseq 恢复任务状态。
撤销只支持最后一步，不撤销导入或另一次撤销；记录被其他设备或原生属性编辑改变后，不覆盖新数据。

面板按已到期、今天、以后、已暂停和历史分组。
同步刷新保留打开的表单、未保存输入和展开的历史；秒级计时仅更新倒计时文本。
如果编辑过程中记录已改变，表单会提示重置输入后再保存。

## 从 v1.6.7 或已有 DB 记录升级

1. 备份原图谱与插件设置。
2. 文件图谱用户先使用 Logseq 官方导入功能迁入数据库图谱，并确认需要保留的计时值已导入；
   继续使用文件图谱时，应保留 v1.6.7。
3. 在支持的 Logseq 客户端上安装插件 v2.1.10，并重载插件。
4. 核对面板中的任务、到期时间和历史；同一图谱的其他设备也升级到 v2.1.10。

首次加载新版插件时，自动将**已经存在于数据库中的完整 `async-timer` 值**升级为原生属性。
此前使用插件 2.0.0 DB 版本的记录也适用此流程。
插件不会直接读取旧文件图谱，不从 Markdown 行、旧 localStorage 缓存或两个分离属性恢复任务；
Logseq 导入过程中没有带入数据库的计时数据，需要从原图谱备份另行恢复。

升级流程：

1. 先读取并检查图谱中的完整记录；重复来源或不匹配的属性类型会报错，不猜测覆盖。
2. 按块保存原生字段与导入历史，写入后重新读取校验。
3. 导入历史保留来源属性标识、原始 `<到期毫秒>~<秒数>` 值和原任务状态。
4. 原 `async-timer` 属性与原任务正文保留，已完成任务进入历史。
5. 升级可重复执行；已有新版数据优先，取消的提醒不会从旧值复活。

只有时长、没有有效到期时间的残留记录不会被推算为计时器，也不会被删除。
升级中断后，下次重载继续处理未升级记录。
多设备应全部升级至 **v2.1.10**；旧插件只认识旧值，无法理解新的暂停、取消和历史。
回退插件文件不能回退数据。确实需要回退时，请使用升级前的完整图谱备份，并评估备份之后的新笔记。

## 原生属性与查询

提醒数据和历史保存在 Logseq 图谱中，随 DB Sync 同步。其他设备也需要安装本插件。
原生字段是实际读取来源，直接在 Logseq 修改时间、负责人或项目后，插件会重新读取。
插件首次创建 `reminder-state`、`next-follow-up` 和 `last-checked` 时，默认在笔记正文中隐藏这三项。所有字段均可用于查询，提醒状态和到期时间也可在时钟面板查看。已有图谱沿用各自的属性显示设置。
字段统一使用 `plugin.property.logseq-async-task-timer/` 命名空间：

- `next-follow-up`：下次跟进，原生 `datetime`；暂停或结束提醒后清空。
- `last-checked`：最近一次跟进操作，原生 `datetime`；导入时不虚构检查时间。
- `follow-up-owner`、`follow-up-project`：负责人、项目，原生 `string`。
- `reminder-state`：`active`、`paused`、`canceled`、`completed`。
- `reminder-duration`、`paused-seconds`：原生 `number`，内部时长。
- `reminder-history`：隐藏的 `json` 属性，保存导入来源和每次操作的前后值。

例如在支持 Datalog 的查询入口查询已设定下次跟进时间的记录：

```clojure
[:find (pull ?b [:block/uuid :block/title]) ?due
 :where
 [?b :plugin.property.logseq-async-task-timer/reminder-state "active"]
 [?b :plugin.property.logseq-async-task-timer/next-follow-up ?due]]
```

这个基础查询按提醒状态筛选；如果原生任务已经在其他地方完成，插件面板会额外将它归入历史。
日期在数据库里是毫秒标量；`number` 属性则由 Logseq 的数值实体承载，查询时通过 `:logseq.property/value` 取值。

每次操作通过 2.0.2 的 `Editor.updateBlock(..., {properties})` 在同一次属性事务里写字段和历史。
保存前检查已有值，保存后重新读取校验。Logseq SDK 没有跨设备条件写入接口；
极短时间内两台设备同时修改同一提醒仍受 DB Sync 的冲突规则影响，不能把它当作分布式锁。

## 通知

运行中的提醒到期时显示应用内提示，可播放短提示音，并在系统授权后显示系统通知。
面板中的「系统通知权限」可检查或请求授权；声音可在插件设置中关闭。
提醒不会强制打开面板打断正在输入的内容。

关闭 Logseq、插件未运行或电脑休眠时，插件无法执行提醒。
运行中的定时器单独等待最近的截止时间。切到后台或短暂休眠后，迟到 10 分钟以内的任务仍会提醒一次。数据库短暂断线后会先核对任务是否仍有效，再按同一时限提醒。超过 10 分钟或启动时已过期的任务只汇总到面板。
在插件面板中点击后可启用短提示音。如果窗口无法播放，插件会请求系统通知带声音，实际效果取决于系统的通知和声音设置。
单独的同步服务器只负责同步笔记，不会替关闭的客户端运行此插件。

### 企业微信群机器人

在插件设置中填写 HTTPS Webhook，然后手动点击「测试企业微信」。
只有 HTTP 成功且机器人响应 `errcode = 0` 才显示接收成功。
正式推送使用 Logseq 2.0.2 的 `Net.request` 主进程代理，不再使用无法确认结果的 `no-cors`。

- 面板显示排队、发送中、已接收、等待重试和最终失败。
- 失败最多发送三次：初次、约 5 秒后、再约 30 秒后；每次发送前重新检查提醒是否仍有效。
- 失败后可点击「重试推送」。重启中断的发送不自动重放，可由用户手动重试。
- 推送记录按图谱与截止时间在本机去重；Webhook、密码或完整响应不写入推送记录。
- Webhook 没有幂等确认接口，网络超时重试有小概率重复送达；不能承诺端到端恰好一次。

Webhook、设备 ID 和推送回执属于本机设置，不随图谱同步。
如果多台设备使用相同 Webhook，在每台设备开启「仅允许一台设备推送」，并填入相同的主机设备 ID。
主机 ID 为空且该开关开启时，由当前设备认领；需要手动将这个 ID 复制到其他设备。

## 安装与更新

从 [v2.1.10 Release](https://github.com/hzphzp/logseq-async-task-timer/releases/tag/v2.1.10)
下载 **`logseq-async-task-timer-v2.1.10.zip`**（已构建的插件包）。
GitHub 自动生成的 “Source code” 压缩包用于源码开发。

将插件包中的 `logseq-async-task-timer` 目录放到 `~/.logseq/plugins/`，
或在 Logseq 插件界面使用「Load unpacked plugin」选择该目录。
替换已安装文件后，在插件界面点「重载」，或重启 Logseq。
用户设置位于 `~/.logseq/settings/`，替换插件文件不会覆盖这些设置。
安装后确认插件版本为 `2.1.10`；市场更新的可见时间以 Logseq 市场为准。

## 开发与验证

```sh
npm ci
npm test
npm run build
# 需要已安装的 Logseq 2.0.2 CLI；可用 LOGSEQ_CLI 指定其路径
npm run test:integration
# 浏览器交互测试页面；只有虚构数据，不连接 Logseq 或发送消息
npm run preview:ui
```

- `src/db-store.js`：DB 属性、一次性升级、保存与校验。
- `src/reminder.js`：状态转换、撤销校验、日期与分组。
- `src/controller.js`：图谱切换、刷新与到期处理。
- `src/notifications.js`：可确认的企业微信发送、有限重试、本机回执。
- `src/readiness.js`、`src/titles.js`：数据库就绪等待、引用标题解析。
- `src/ui.js`、`src/style.css`：保留表单状态的面板和编辑器。
- `src/index.js`：Logseq SDK、菜单、设置与各模块的连接。

自动化测试覆盖状态、撤销冲突、图谱切换、失败保存、休眠恢复、通知去重和重试、输入保留和 HTML 转义。
集成测试创建独立、未同步的图谱，使用实际 2.0.2 worker 验证原生属性、迁移幂等性、
历史保留、完成/撤销、正文/子块保留、原生编辑以及同步后的完成/删除。
SDK 到 worker 的操作按官方源码映射；这不替代 Logseq 桌面插件 iframe 的交互验收。
所有自动化网络测试使用模拟传输，不向真实企业微信群发送消息。

本版本通过 28 项自动化测试、真实 2.0.2 worker 集成测试、35 条完整计时记录的迁移演练，
以及桌面插件重载后的标题与面板人工验收。测试记录不随发布包分发。

发布时，`v<版本>` 标签必须与 `package.json` 一致，并提供 `docs/releases/v<版本>.md`。
GitHub Actions 会检查版本和说明、运行测试与构建，再发布带说明的 Release、插件 ZIP 和独立的 `package.json`。

`vendor/logseq-sdk` 固定为官方 2.0.2 应用自带的 SDK 0.3.4；来源、校验值与许可见 `NOTICE.txt`。
npm 上的旧 `@logseq/libs` 0.0.17 不用于此版本。

接口依据：
[2.0.2 SDK](https://github.com/logseq/logseq/blob/533ac43/libs/src/LSPlugin.ts)、
[DB 属性指南](https://github.com/logseq/logseq/blob/533ac43/libs/guides/db_properties_guide.md)、
[网络接口](https://github.com/logseq/logseq/blob/533ac43/libs/src/modules/LSPlugin.Net.ts)。

## English

> [!IMPORTANT]
> **Plugin v2.1.10 requires Logseq 2.0.2+ within the 2.x series and a DB graph.**
> Logseq 0.x, 2.0.0, 2.0.1, file graphs, and 3.x are not supported.
> Legacy support has been discontinued. Existing file-graph users should keep
> [v1.6.7](https://github.com/hzphzp/logseq-async-task-timer/releases/tag/v1.6.7) and must not install this release.

The **plugin version (2.1.10)** is separate from the **Logseq client version (2.0.2)**.
The runtime accepts Logseq `>= 2.0.2, < 3.0.0` DB graphs. The tested client is Logseq Desktop
2.0.2, revision `533ac43`; other 2.x versions have not each been verified.

Scheduling preserves the native task status. Pause, resume, cancel and complete are separate actions;
history survives each action, and the last action can be undone when the record has not changed.

The panel groups overdue, today, later, paused and archived reminders. It supports search, project filtering,
bulk follow-ups, calendar presets, native datetime/owner/project properties, and preserves unsaved inputs during refresh.
Newly created reminder state, next follow-up time and last-checked time properties are hidden on note blocks by default. All three can be queried. Existing graphs use their own visibility settings.
Complete DB-imported timer values are migrated once, with their original properties and source values retained.
Back up first. File-graph users must use Logseq's official import into a DB graph and verify that their complete
timer values survived that import before upgrading. This plugin does not import Markdown or recover legacy caches.
Upgrade every device to **v2.1.10**; old plugin versions do not understand the new state model.
Startup now waits for the DB worker, and stored UUID references display their readable titles without changing the notes.

WeCom delivery requires HTTP success and `errcode = 0`. Failed live deliveries retry at most three times,
with graph-scoped local receipts and manual retry after interruption. A background or wake-up delay of up to ten minutes still delivers a live deadline once. The same deadline check runs after reconnection. Startup and older deadlines are summarized without sending a backlog. Logseq must be running. Network timeouts can still cause duplicate delivery.

Build with `npm ci`, `npm test`, `npm run build`. Integration tests use an isolated Logseq 2.0.2 worker.
`npm run preview:ui` starts a mock UI fixture at `http://127.0.0.1:5178/`. Reload the installed plugin after replacing files.

Download the built `logseq-async-task-timer-v2.1.10.zip` from the
[release page](https://github.com/hzphzp/logseq-async-task-timer/releases/tag/v2.1.10).
See [the full release notes](docs/releases/v2.1.10.md) for compatibility, migration, validation and limitations.

## License

Original plugin source: [MIT](./LICENSE). The bundled Logseq SDK retains its upstream license;
see [SDK sources and notices](vendor/logseq-sdk/NOTICE.txt) and the license files in that directory.
