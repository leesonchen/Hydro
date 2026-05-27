# XXWL Review Plugin

临时查询页：登录用户访问 `/xxwl-review`，输入考试编号（如 `A001`）查看该学生的成绩、评测串和个人分析。

## 数据与实时生成

插件不内置任何绝对数据路径。请在 Hydro addon 配置中设置：

- `dataDir`：`xxwl_judge` 项目目录，需包含 `cache/analysis.json`、`reviews/`、`代码/`
- `baseUrl`：OpenAI-compatible API base URL，例如 `https://api.openai.com/v1`
- `apiKey`：OpenAI-compatible API key（secret 字段）
- `model`：例如 `gpt-5.5`
- `reasoningEffort`：默认 `high`

查询时如果 `reviews/{id}.md` 已存在，页面直接展示该文件。若不存在，页面会显示“正在生成”，并调用 `/xxwl-review/generate` 实时按 `review.py` 同款 prompt 读取源码、评测串和成绩生成评语，生成后写入 `reviews/{id}.md`，下次查询直接复用。

也可以用环境变量临时提供数据目录：

```powershell
$env:XXWL_REVIEW_DATA_DIR="D:\\path\\to\\xxwl_judge"
```

## 启用示例

```powershell
cd D:\work\hydro\Hydro
corepack yarn hydrooj addon add D:\work\hydro\Hydro\packages\xxwl-review
corepack yarn build
corepack yarn start
```

然后登录 Hydro，访问 `/xxwl-review`。
