# Hydro "复制域"功能设计文档

## 1. 概述

"复制域"功能旨在为超级管理员提供一种快速创建新域的方式。管理员可以指定一个源域作为模板，将其核心配置和内容（如题目、比赛等）复制到一个新的域中，从而大大简化相似域的初始化过程。

## 2. 用户故事与用例

- **角色**: 超级管理员
- **目标**: 快速为新的班级、分校或活动创建一个与现有域配置和内容相似的新域。
- **场景**:
  1. 管理员进入系统后台的域管理界面。
  2. 选择"复制域"功能，打开功能弹窗或页面。
  3. 在表单中，选择一个"源域"，并输入"新域ID"、"新域名称"和"新域拥有者"的ID。
  4. 管理员可以选择要一同复制的内容，例如：
     - [x] 域设置 (默认勾选)
     - [x] 域角色 (默认勾选)
     - [x] 题目
     - [x] 比赛
     - [ ] 训练
  5. 点击"开始复制"按钮，系统启动后台任务，并提示管理员任务已开始。
  6. 管理员可以通过任务中心查看复制进度和最终结果。

## 3. UI/UX 设计

- **入口**: 在域管理列表页面，增加一个"复制域"按钮。
- **交互形式**: 点击按钮后，弹出一个模态框（Modal）。
- **表单设计**:
  - **源域 (Source Domain)**:
    - 类型: `Select` 下拉框，带搜索功能。
    - 数据: 系统中所有域的列表。
    - 必填: 是。
  - **新域ID (New Domain ID)**:
    - 类型: `Input` 文本框。
    - 验证: 必填，唯一，符合ID格式要求。
    - 必填: 是。
  - **新域名称 (New Domain Name)**:
    - 类型: `Input` 文本框。
    - 必填: 是。
  - **新域拥有者 (New Domain Owner)**:
    - 类型: `Input` 文本框，支持用户ID或用户名搜索的自动完成。
    - 必填: 是。
  - **复制选项 (Copy Options)**:
    - 类型: `Checkbox` 组。
    - 选项:
      - `域基础设置与角色` (必选且默认勾选)
      - `题目`
      - `比赛`
      - `训练`
- **操作**:
  - `开始复制`: 提交表单，触发API调用。
  - `取消`: 关闭模态框。

## 4. 后端 API 设计

### 4.1 端点 (Endpoint)

`POST /api/domain/copy`

### 4.2 权限 (Permission)

需要全局权限 `PRIV_CREATE_DOMAIN`。

### 4.3 请求体 (Request Body)

```json
{
  "sourceDomainId": "source_school",
  "newDomainId": "new_branch",
  "newDomainName": "New Branch Campus",
  "newOwnerId": 1002,
  "options": {
    "copyProblems": true,
    "copyContests": true,
    "copyTrainings": false
  }
}
```

### 4.4 响应 (Response)

- **成功 (202 Accepted)**:
  - 表示任务已接受并在后台处理。
  ```json
  {
    "taskId": "63e8c8b6f3b7c7b8e8a0b1a2",
    "message": "Domain copy task has been scheduled."
  }
  ```
- **失败**:
  - `400 Bad Request`: 输入参数验证失败（如新域ID已存在）。
  - `403 Forbidden`: 用户权限不足。
  - `404 Not Found`: 源域不存在。

## 5. 后端逻辑与工作流 (异步任务)

为避免长时间阻塞请求，复制操作将作为一个后台任务执行，使用 `task` 集合进行调度。

### 5.1 任务创建

- `DomainHandler` 的 `copy()` 方法接收到API请求后，进行基本验证（权限、参数格式）。
- 验证通过后，在 `task` 集合中创建一个新任务，类型为 `domain_copy`，状态为 `waiting`，并将请求体中的所有参数存入任务的 `args` 字段。
- 立即返回 `202` 响应和任务ID。

### 5.2 任务执行流程

一个专门的 `TaskRunner` 会消费 `domain_copy` 类型的任务。

1.  **任务开始**: `TaskRunner` 获取任务，更新其状态为 `running`。
2.  **验证**: 再次验证源域是否存在，新域ID是否被占用。
3.  **创建新域**:
    - 调用 `DomainModel.create()` 创建一个基础的新域文档，设置 `_id`, `name`, `owner` 等基本信息。
4.  **复制设置与角色**:
    - 读取源域文档的 `settings` 和 `roles` 字段。
    - 将这两个对象深拷贝到新域文档中并保存。
5.  **复制题目 (如果 `copyProblems` 为 `true`)**:
    - 查询 `problem` 集合，获取所有 `domainId` 为源域ID的题目。
    - 遍历题目列表，对每个题目进行如下操作：
        a.  **复制元数据**: 创建一个新的题目对象，复制 `pid`, `title`, `content`, `config`, `tag` 等字段，将 `domainId` 设置为新域ID，并将 `nSubmit`, `nAccept`, `stats` 等统计信息重置为零。
        b.  **复制文件**:
            - 题目的 `data` 和 `additional_file` 字段存储的是文件ID (`ObjectId`)。
            - 遍历这些文件ID，为每个ID调用 `StorageService.copy(fileId)`。
            - `StorageService.copy` 会在底层存储（本地或S3）中复制文件实体，并返回一个新的文件ID。
            - 将返回的新文件ID存入新题目对象的 `data` 数组中。
        c.  将处理好的新题目对象存入一个临时数组。
    - 使用 `ProblemModel.insertMany()` 将所有新题目一次性批量写入数据库。
    - 记录旧题目 `_id` 到新题目 `_id` 的映射关系，供后续复制比赛时使用。 `Map<ObjectId, ObjectId>`
6.  **复制比赛 (如果 `copyContests` 为 `true`)**:
    - 查询 `contest` 集合，获取所有 `domainId` 为源域ID的比赛。
    - 遍历比赛列表，对每个比赛进行如下操作：
        a.  创建一个新的比赛对象，复制 `title`, `content`, `rule`, `beginAt`, `endAt` 等信息，将 `domainId` 设置为新域ID，并将 `attend` 等与用户相关的数据清空。
        b.  **重映射题目**: 遍历比赛的 `pids` 数组。根据上一步记录的题目ID映射关系，将旧的题目ID替换为新复制的题目ID。
        c.  将处理好的新比赛对象存入临时数组。
    - 使用 `ContestModel.insertMany()` 批量写入数据库。
7.  **复制训练 (如果 `copyTrainings` 为 `true`)**:
    - 流程与复制比赛类似，需要重映射题目ID。
8.  **任务结束**:
    - 所有步骤成功后，更新任务状态为 `success`。
    - 如果任何步骤失败，捕获异常，将错误信息记录到任务中，并更新状态为 `fail`。

## 6. 受影响的模块与修改点

-   **`packages/ui-default`**:
    -   **新增**: `components/DomainCopyModal.tsx` - 实现复制域的UI模态框。
    -   **修改**: 域管理页面 - 添加"复制域"按钮及其事件处理。

-   **`packages/hydrooj`**:
    -   **修改**: `handler/domain.ts` - 新增 `copy` 方法来处理 `POST /api/domain/copy` 请求，并创建后台任务。
    -   **新增**: `task_runner/domain_copy.ts` (或类似机制) - 增加处理 `domain_copy` 类型任务的逻辑。
    -   **修改**: `service/storage.ts` - **必须新增**一个 `async copy(sourceFileId): Promise<newFileId>` 方法。此方法需要：
        -   读取源文件的元数据和内容。
        -   创建一个新的文件记录和内容副本。
        -   返回新文件的ID。
    -   **修改**: `model/problem.ts`, `model/contest.ts` - 可能会增加一些辅助性的 `clone` 方法，以便于复制逻辑的实现。

## 7. 数据库变更

-   **`task` 集合**: 新增一种任务类型 `domain_copy`。
-   无需修改任何现有集合的 Schema。

--- 