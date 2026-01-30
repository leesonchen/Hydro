# Course Management Plugin

## 概述

Course Management 是 Hydro OJ 的课程管理插件，提供完整的课程系统，包括班级管理、课程创建、讲义系统、成绩统计等功能。该插件从编译后的 `plugin-YcAJ` 逆向重构而来，并进行了完全的 TypeScript 重写。

## 功能清单

### 1. 课程系统（Contest Rule）
- **课程规则**：基于 IOI 规则扩展，支持章节式课程设计
- **DAG 章节**：支持章节的前置条件依赖关系
- **自动解锁**：学生完成前置章节后自动解锁后续章节
- **灵活的完成条件**：
  - `all`: 完成章节内所有题目
  - `problem`: 完成指定数量的题目
  - `score`: 达到指定总分
- **章节默认值**：新建课程默认章节标题为“标题 N”，题目必填

### 2. 班级管理
- **班级创建和编辑**：创建班级，设置教师和学生
- **班级归档**：支持手动归档，归档班级在课程分配/选择时默认隐藏
- **班级时间范围**：设置班级的开始和结束时间
- **模板复制**：从模板库一键复制课程到班级

### 3. 课程管理
- **课程创建**：支持创建普通课程和课程模板（模板=assign 到 TEACHERS 班级）
- **课程编辑**：修改课程标题、内容、DAG 结构、分配对象
- **课程删除**：删除课程及其所有相关数据
- **课程分配**：仅可选择未归档班级

### 4. 讲义系统
- **讲义编辑**：为每个章节编写讲义（支持 Markdown）
- **文件管理**：上传课程相关文件（讲义、资源等）
- **文件下载**：学生可下载课程文件
- **访问控制**：精细控制讲义访问权限

### 5. 成绩管理
- **成绩统计**：按章节统计学生成绩
- **成绩板**：显示学生的题目完成情况、分数、尝试次数
- **成绩导出**：支持导出为 CSV 和 HTML 格式
- **进度追踪**：显示学生的课程完成进度

### 6. 权限管理
- **课程访问控制**：按班级或学生分配课程访问权限
- **章节权限**：为特定学生开放或关闭章节访问
- **讲义权限**：独立控制讲义访问权限
- **管理员操作**：支持批量授予或撤销权限

## 系统需求

### 环境
- Node.js >= 22.14.1
- Hydro OJ >= 4.19.0（当前支持版本）
- MongoDB >= 6.0
- TypeScript 5.0+

### 依赖包
- `hydrooj`: 核心框架
- `schemastery`: 配置模式定义

## 安装和使用

### 安装
```bash
# 方式1：从源代码安装（开发）
cd packages/course-management
yarn install
yarn build

# 方式2：通过 hydrooj 命令安装
hydrooj install @hydrooj/course-management
```

### 启用插件
在域设置中启用课程功能：
1. 进入域管理 -> 设置
2. 找到 `Enable Course` 选项并启用
3. 或在 `config.yaml` 中配置：
```yaml
course-management:
  enable: true
```

### 基本流程

1. **创建班级**
   - 域管理员进入"管理班级"
   - 点击"创建班级"，填写班级信息、教师、学生
   - 可以选择从模板复制课程到班级

2. **创建课程模板**（系统管理员）
   - 进入课程创建页面，勾选“创建为模板”
   - 系统固定分配给 TEACHERS 班级（若不存在则自动创建）
   - 模板创建时隐藏开始/结束时间与班级选择
   - 定义 DAG 章节结构和前置条件
   - 编写讲义内容、上传资源

3. **分配课程到班级**
   - 教师创建课程或复制模板
   - 选择未归档班级进行分配
   - 教师可以管理学生的章节访问权限

4. **学生学习课程**
   - 学生进入课程页面
   - 查看可用章节和讲义
   - 完成题目，系统自动解锁后续章节
   - 可查看个人成绩和进度

## 权限要求

### 必需权限

| 功能 | 权限 | 说明 |
|------|------|------|
| 查看课程 | `PERM_VIEW_HOMEWORK` | 查看课程列表和详情 |
| 创建课程 | `PERM_CREATE_HOMEWORK` | 创建普通课程 |
| 编辑课程 | `PERM_EDIT_HOMEWORK` 或 `PERM_EDIT_HOMEWORK_SELF` | 编辑课程 |
| 查看成绩板 | `PERM_VIEW_HOMEWORK_SCOREBOARD` | 查看课程成绩板 |
| 管理班级 | `PERM_EDIT_HOMEWORK` 或 `PERM_EDIT_HOMEWORK_SELF` | 创建和管理班级 |
| 课程维护者 | `maintainer` 字段 | 可跳过章节/讲义访问限制（始终可查看） |

### 推荐用户组
- **管理员**：拥有所有权限
- **教师**：拥有 `PERM_CREATE_HOMEWORK` 和 `PERM_EDIT_HOMEWORK`
- **学生**：拥有 `PERM_VIEW_HOMEWORK`

## 数据模型

### 课程文档（Course/Contest）
```typescript
interface CourseTdoc extends Tdoc {
  rule: 'course';                    // 规则类型
  dag: DagNode[];                    // DAG 章节结构
  assign?: string[];                 // [班级名, 模板分类?]，模板为 ['teachers', category?]
  lecture?: Record<number, string>; // 章节讲义内容
  files?: FileInfo[];                // 课程文件列表
  maintainer?: number[];             // 课程维护者
}
```

### 班级文档（Group）
```typescript
interface ClassGDoc {
  _id: ObjectId;
  domainId: string;
  name: string;                      // 班级名称
  teachers: number[];                // 教师 UID
  students: number[];                // 学生 UID
  uids: number[];                    // teachers + students
  beginAt: Date;                     // 班级开始时间
  endAt: Date;                       // 班级结束时间
  archive: boolean;                  // 是否归档
  class: true;                       // 标识为班级
}
```

### 课程状态文档
```typescript
interface CourseStatus {
  allow: Record<number, boolean>;       // 章节访问权限 {nodeId: true/false}
  lectureAllow: Record<number, boolean>; // 讲义访问权限
  attend: boolean;                       // 是否已加入
  startAt?: Date;                        // 开始时间
  progress: number;                      // 完成进度（百分比）
  score: Record<number, number>;         // 按章节分数
  accept: Record<number, number>;        // 按章节完成数
  detail: Record<number, any>;           // 题目详细结果
  journal?: any[];                       // 提交记录
}
```

### DAG 节点（章节）
```typescript
interface DagNode {
  _id: number;                          // 章节 ID
  title: string;                        // 章节标题
  lecture?: string | boolean;           // 讲义内容或是否有讲义
  pids: number[];                       // 包含的题目
  requireNids?: number[];               // 前置章节
  completeCondition?: {
    type: 'all' | 'problem' | 'score'; // 完成条件类型
    value?: number;                    // 条件值
  };
}
```

## API 端点

### 课程相关

| 方法 | 路由 | Handler | 说明 |
|------|------|---------|------|
| GET | `/course` | CourseMainHandler | 课程列表 |
| GET/POST | `/course/create` | CourseEditHandler | 创建课程 |
| GET | `/course/:tid` | CourseDetailHandler | 课程详情 |
| GET/POST | `/course/:tid/edit` | CourseEditHandler | 编辑课程 |
| POST | `/course/:tid/edit` | CourseEditHandler | 删除课程 (operation=delete) |
| GET | `/course/:tid/manage` | CourseManageHandler | 课程管理 |
| POST | `/course/:tid/manage` | CourseManageHandler | 访问权限控制 |
| GET | `/course/:tid/lecture/:id` | CourseLectureHandler | 讲义页面 |
| POST | `/course/:tid/lecture/:id` | CourseLectureHandler | 更新讲义 |
| GET | `/course/:tid/file/:filename` | CourseFileDownloadHandler | 下载文件 |
| GET | `/course/:tid/scoreboard/:id` | CourseScoreboardHandler | 查看成绩板 |
| GET | `/course/:tid/scoreboard/:id/:ext` | CourseScoreboardHandler | 导出成绩 |

### 班级相关

| 方法 | 路由 | Handler | 说明 |
|------|------|---------|------|
| GET | `/domain/class` | ClassHandler | 班级列表 |
| GET/POST | `/domain/class/create` | ClassEditHandler | 创建班级 |
| GET/POST | `/domain/class/:id/edit` | ClassEditHandler | 编辑班级 |
| POST | `/domain/class/:id/edit` | ClassEditHandler | 删除班级 (operation=delete) |
| POST | `/domain/class/:id/edit` | ClassEditHandler | 复制课程 (operation=copy) |

## 配置选项

### 系统设置
```yaml
course-management:
  enable: boolean  # 启用课程功能，默认 true
```

### 域设置
```yaml
enableCourse: boolean  # 为该域启用课程功能
```

### 限制设置
```yaml
limit:
  contest_files: number      # 课程最大文件数，默认 100
  contest_files_size: number # 课程文件总大小限制，字节
```

## 多语言支持

插件支持中英文：
- 中文 (`zh_CN`)：完整支持
- 英文 (`en`)：基础支持

所有可翻译字符串定义在 `locales/zh.yaml` 中。

## 扩展和定制

### 添加新的完成条件
在 `model/course.ts` 的 `checkNodeComplete` 函数中添加新的条件类型。

### 自定义成绩板显示
编辑 `model/course.ts` 中的 `scoreboardHeader` 和 `scoreboardRow` 方法。

### 自定义讲义渲染
编辑 `templates/course_lecture.html` 或在 `handler/course.ts` 中修改讲义处理逻辑。

## 常见问题

### Q: 如何批量导入课程？
A: 通过班级管理的"模板复制"功能实现。先创建课程模板，然后在班级编辑页面复制到班级。

### Q: 学生看不到创建的课程怎么办？
A: 检查以下几点：
1. 课程是否已分配给学生所在的班级
2. 课程的访问权限是否正确设置
3. 用户是否有 `PERM_VIEW_HOMEWORK` 权限

### Q: 如何只让特定学生查看某个章节？
A: 在课程管理页面，点击"允许用户"按钮，为用户开放或关闭特定章节。

### Q: DAG 前置条件如何设置？
A: 在课程编辑页面的 DAG JSON 中，为节点添加 `requireNids` 字段，指定前置章节的 ID。

## 故障排除

### 班级不显示
- 检查班级是否有 `class: true` 标记
- 检查 domainId 是否正确

### 课程不显示
- 检查课程的 `assign` 字段是否包含用户所在的班级
- 检查课程规则是否为 `course`
- 检查用户权限

### 讲义无法编辑
- 检查用户是否拥有 `PERM_EDIT_HOMEWORK` 权限
- 检查是否为课程所有者

### 文件上传失败
- 检查文件数量是否超过限制
- 检查文件大小是否超过限制
- 检查存储空间是否足够

## 版本历史

### v0.0.1
- 初始版本
- 从 plugin-YcAJ 逆向重构
- 完整的 TypeScript 实现
- 支持课程、班级、讲义、成绩管理

## 许可证

AGPL-3.0-or-later

## 贡献者

- 原始设计：plugin-YcAJ
- 逆向重构：Claude Code Assistant
