# XXWL Review Plugin

临时查询页：登录用户访问 `/xinxi`，输入考试编号（如 `A001`）查看该学生的成绩、评测串和个人分析。

## 数据与实时生成

插件默认使用本插件目录下的 `data` 作为数据目录，也就是 `packages/xxwl-review/data`。如果在 Hydro addon 配置里设置了 `dataDir`，相对路径会按本插件目录解析；生产环境也可以改成绝对路径。

- `dataDir`：默认 `data`，需包含 `cache/analysis.json`、`reviews/`、`code/`
- `baseUrl`：OpenAI-compatible API base URL，例如 `https://api.openai.com/v1`
- `apiKey`：OpenAI-compatible API key（secret 字段）
- `model`：例如 `gpt-5.5`
- `reasoningEffort`：默认 `high`
- `statementMaxChars`：每道题题面放入 prompt 的最大字符数，默认 `8000`
- `solutionMaxChars`：每份参考解法放入 prompt 的最大字符数，默认 `6000`
- `adminUids`：允许点击“重新分析”并覆盖 review 的 Hydro UID，默认 `1966`，多个 UID 用英文逗号、分号或空格分隔

查询时如果 `reviews/{id}.md` 已存在，页面直接展示该文件。若不存在，页面会显示“正在生成”，并调用 `/xinxi/generate` 实时读取完整题面、参考解法、学生源码、评测串和成绩生成评语，生成后写入 `reviews/{id}.md`，下次查询直接复用。

当前插件只读取以下内容：

```text
data/cache/analysis.json
data/reviews/{id}.md
data/code/{id}/p1.cpp ... p6.cpp
data/problems/p1.md ... p6.md
data/solutions/p1/*.cpp ... p6/*.cpp
```

源码目录已统一为英文 `code/`。`data/problems/` 会作为完整题面加入 prompt，`data/solutions/` 会作为参考解法加入 prompt，用来校准正确思路和定位差距。`题目/` 目录不是插件运行必需项；如果保留题面资料，建议放在 `data/problems/`。

也可以用环境变量临时提供数据目录：

```powershell
$env:XXWL_REVIEW_DATA_DIR="D:\\path\\to\\xxwl_judge\\data"
```

## 启用示例

```powershell
cd D:\work\hydro\Hydro
corepack yarn hydrooj addon add D:\work\hydro\Hydro\packages\xxwl-review
corepack yarn build
corepack yarn start
```

然后登录 Hydro，访问 `/xinxi`。
