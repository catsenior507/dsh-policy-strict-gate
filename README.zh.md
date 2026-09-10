<div align="center">

# 严格闸 · Strict Gate

**一个模型必须记得去调用的工具,恰恰会在最需要它的时候被跳过。**

一个 DeepSeek Harness 宿主插件:把 `strict_check` 和失败日志,从 agent **可以**用的东西,
变成宿主**强制执行**的策略。

[![License: MIT](https://img.shields.io/badge/license-MIT-3DA639.svg)](LICENSE)
[![DeepSeek Harness plugin](https://img.shields.io/badge/DeepSeek%20Harness-tool%20plugin-4D6BFE.svg)](#install)
[![version](https://img.shields.io/github/package-json/v/catsenior507/dsh-policy-strict-gate?color=4D6BFE)](package.json)
[![node](https://img.shields.io/badge/node-%3E%3D20-3DA639.svg)](package.json)
[![stars](https://img.shields.io/github/stars/catsenior507/dsh-policy-strict-gate?color=4D6BFE)](https://github.com/catsenior507/dsh-policy-strict-gate/stargazers)

[English](README.md) · **简体中文**

</div>

---

## 它解决什么

前面两个插件给了 agent 能力。这一个,把"要不要用这些能力"的决定权从 agent 手里拿走。

这不是对 agent 的批评 —— 这是关于**检查会在什么时候被跳过**的陈述。自律恰恰在
最要命的时刻失效:模型很自信的时候、在赶进度的时候、已经陷入循环的时候。
那些时刻检查最值钱,也最不可能被主动调用。

还有第二个理由,也是真正说服我做这个的原因:**检查结果落在工具返回值里,是可以被略读的;
而检查结果变成"拒绝下一次写入",略不过去。**

## 三道闸

各自独立失效、独立配置,关掉一道不影响另外两道。

### 1. 重复失败

同一个失败签名在一个会话里出现 `repeatThreshold` 次(默认 3),就排入一条通知,
写明失败类别、内置修复提示,以及"你必须改点什么"的指令。之后每隔
`repeatCooldown` 次再提醒一次,所以长时间循环不会淹没上下文。

宿主对**逐字节相同**的调用已经做了类似的事。这里把它扩展到"空格或路径不同、
但死于同一个原因"的调用。

刻意挂在 `tools/result` 而不是 `tools/post-execute` 上:前者对**每一个**已结算的结果
都会触发,包括绕过 post-execute 的那些管道失败 —— 被拒绝的调用、未知工具、
被本闸拒绝的调用。一个模型反复撞被拒的调用,恰恰是最值得打断的循环。

### 2. 关键路径

对受保护 glob 命中路径的写入会被**拒绝**,直到有一份覆盖它的 Lean 规格通过检查。

两个设计选择让它成为"策略"而不是"障碍":

**拒绝理由里带诊断。** 宿主会丢弃被拒调用的结果,所以一句只说"已阻止"的拒绝,
会把满足这道闸所需的信息一起销毁。所以闸在拒绝**之前**先跑检查,并把发现的东西引出来。

**修复通道永远打开。** 正在修"闸刚刚报出的那个诊断"的写入会被放行。没有这条规则,
闸就死锁了 —— 它会拒绝"对它所报错误的修复",而且没有任何出路。
这就是计数器里的 `repairPasses`,也是这个插件里最重要的一个行为。

每次拒绝都会打印三条出路:满足闸、重试修复、或把该路径从 `criticalPaths` 移除。

### 3. 写后语法检查

每一个被接受的写入,紧接着就跑该语言自己的检查
(`py_compile`、`node --check`、PowerShell 解析器),诊断随上下文一起进入下一步。

这是最便宜、也最经常回本的一层:它在**弄坏文件的那一步**就抓住它,
而不是三个命令之后通过一个不相关的失败才发现。

<a id="install"></a>
## 安装

本插件作为包安装进一个 dsh **profile**。`dsh plugin` 会在 profile 目录里转发给 `pnpm`,
所以 pnpm 接受的任何 spec 都可以用。

```bash
# 从 GitHub 安装（公开发布形式）
dsh plugin --profile web add github:catsenior507/dsh-policy-strict-gate

# 本地检出安装（开发时用）
dsh plugin --profile web add /absolute/path/to/dsh-policy-strict-gate
```

`web` 是自带 GUI 的 profile;可换成 `headless`、`sdk`、`acp` 或你自己的 profile 名。
Windows 上路径用正斜杠,或给路径加引号。

关键路径闸和写后检查依赖它用来判断的检查器,请一并安装:

```bash
dsh plugin --profile web add github:catsenior507/dsh-tool-strict-check
```

闸通过遍历 DSH 的 profile 目录来定位那个包,所以两者是 link 还是各自独立安装都能工作;
如果它不在,闸会明说,并让那两道检查闸停用,而不是靠猜。

装完**重启宿主**,然后确认:

```
strict_gate_status action=status
```

### 安装**不会**做的事

- **没有构建步骤** —— 发布的 JavaScript 就是源码;不会跑 `prepare` 脚本。
- **没有依赖** —— `dependencies` 和 `peerDependencies` 都是空的。
- **`strict-check` 在加载期是可选的。** 没有它你仍然有"重复失败"那一道闸;
  失去的是另外两道。

需要 Node.js 20 或更新版本。

## 开启关键路径闸

它出厂是**关闭**的,因为那份 glob 清单是关于**你的**代码的陈述,没有插件能替你猜。
在你设置之前,另外两道闸照常工作。

`dsh plugin add` 已经替你插入了插件行。把清单加进 profile 的 `cordis.patch.yml`
里那一行的 `config`:

```yaml
- insert:
    - id: policy-strict-gate
      name: '@dsh-external/dsh-policy-strict-gate'
      config:
        criticalPaths:
          - 'src/core/**'
          - 'src/**/*.spec.lean'
        protectedTools: ['write', 'edit']
        repeatThreshold: 3
        repeatCooldown: 3
        postWriteSyntax: true
        maxDiagnostics: 5
```

用 `strict_gate_status action=targets path=<某个文件>` 确认某个路径**真的**被保护、
被哪条规则保护 —— glob 静默匹配失败、导致这道闸"看着开着其实什么都没做",
是它最常见的失效方式。

### 规格是怎么被找到的

对受保护目标 `src/core/x.ts`,闸按顺序找:

1. `src/core/x.spec.lean`
2. `src/core/x.ts.lean`
3. `src/core/specs/x.lean`

无论 glob 怎么写,`.lean` 文件**永远不会**被闸拒绝 —— 规格是满足这道闸的方式,
拦住写规格会让这道闸无法被满足。

## 自省

`strict_gate_status` 报告哪些闸处于活动状态、编译出来的 glob 规则,以及计数器:

| 计数器 | 含义 |
| --- | --- |
| `failures observed` | 观察到的已结算异常调用数 |
| `repeat notices sent` | 已送达的"你在重复"通知数 |
| `critical-path refusals` | 被 glob 闸拒绝的写入数 |
| `repair writes allowed through` | 因为属于"修复"而被放行的拒绝数 |
| `spec checks run by the gate` | 闸自己执行的 Lean 检查数 |

一个静默运行的策略,和一个坏掉的策略,是无法区分的 —— 这个工具的存在就是让差别可见。

## 开发

```bash
npm test        # 72 个测试；集成测试会真的跑 Lean 内核
```

集成测试驱动的是**真实协作者**而不是桩,因为它们要防的故障是静默的:
两个插件对"已验证"的理解不一致,会让闸拒绝掉模型刚被告知"没问题"的写入。
`test/activation.test.js` 更进一步,驱动**真实的 cordis waterfall** ——
因为监听器挂在错误的事件名上、或者从不调用 `next()`,都不会抛任何异常,
只会让策略静默地不存在。

四个值得记住的 bug,全都是测试抓出来的而不是 review 看出来的:

- **状态用对象身份做键。** 状态袋原本是 `WeakMap`,键是 agent 对象。宿主对**同一个
  agent 在不同钩子里传的是不同对象**,于是闸在一个袋子里记下"规格已通过",
  却去另一个袋子找 —— 永久拒绝。现在按 session id 做键,并有容量上限。
- **规格的主语是用字符串手术推导的。** `x.spec.lean` 的词干是 `x`,
  但真实文件是 `x.ts`;记下 `x` 等于把一个修复窗口开在**任何写入都匹配不到**的路径上。
  现在主语是按目录解析出来的。
- **卸载时的未处理 Promise 拒绝。** 钩子是在异步续体里挂载的,所以一次重载会在协作者
  import 完成前就 dispose 掉 fiber;此时注册 effect 会抛
  `cannot create effect on inactive context`,而且抛在**游离 promise** 里。
  那是"插件被卸载"引发的宿主级故障,现在通过询问框架"fiber 是否还活着"来防住。
- **重复失败通知无法挂到它所描述的那次调用上。** `tools/result` 没有决策通道,
  所以通知会排队,在**下一次**调用的 `pre-execute` 上送达。这是对的,但很容易被误判成 bug。

### 送达路径,精确地说

| 通知产生于 | 送达方式 | 延迟 |
| --- | --- | --- |
| `tools/result`(一次失败) | 排队 → 下一次调用的 `pre-execute` | 一次调用 |
| `tools/post-execute`(一次写入、一次检查) | 该结果的 `additionalContexts` | 无 |
| 一次拒绝 | `deny` 的 reason 文本 | 立即 |

拒绝没有 `additionalContexts`,所以为那一步排队的东西会被追加到 reason 字符串里 ——
否则一次拒绝就会静默吞掉"由这次拒绝所参与的循环"产生的那条重复提醒。

| 文件 | 职责 |
| --- | --- |
| `lib/index.js` | 挂载、协作者发现、卸载保护 |
| `lib/gate.js` | 三道闸及其决策 |
| `lib/matching.js` | glob 编译、路径提取、规格主语解析 |
| `lib/signature.js` | 失败身份与修复提示目录 |
| `lib/notify.js` | 唯一能抵达模型下一步的通道 |
| `lib/status.js` | `strict_gate_status` |

## 许可

MIT
