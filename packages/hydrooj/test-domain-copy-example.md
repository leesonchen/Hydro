# 域复制功能测试指南

## 功能概述

域复制功能允许用户将一个域（domain）的所有内容完整复制到另一个新域，包括：

- 域基本设置（名称、公告、角色配置）
- 题库和测试数据
- 比赛和作业
- 训练计划
- 用户权限和分组
- 讨论和题解

## 快速开始

### 1. 通过Web界面使用

1. 访问 `/domain/copy` 页面
2. 选择源域和目标域ID
3. 配置复制选项
4. 点击"开始复制"

### 2. 通过命令行测试

```bash
# 基本复制测试
node src/script/test-domain-copy.js --source=source_domain --target=test_copy --problems --contests --cleanup

# 完整复制测试
node src/script/test-domain-copy.js \
  --source=production_domain \
  --target=test_environment \
  --problems \
  --contests \
  --trainings \
  --users \
  --groups \
  --preserve-ids \
  --cleanup

# 仅预检查（不执行实际复制）
node src/script/test-domain-copy.js \
  --source=source_domain \
  --target=target_domain \
  --dry-run
```

## 测试用例

### 测试用例 1：基础域复制

**目标**: 验证基本域创建功能

```bash
node src/script/test-domain-copy.js \
  --source=system \
  --target=test_basic \
  --cleanup
```

**预期结果**:
- 创建新域 `test_basic`
- 复制源域的基本设置
- 测试后自动清理

### 测试用例 2：题库复制

**目标**: 验证题目和测试数据复制

```bash
node src/script/test-domain-copy.js \
  --source=contest_domain \
  --target=test_problems \
  --problems \
  --preserve-ids \
  --cleanup
```

**预期结果**:
- 复制所有题目
- 保持原题目ID
- 复制测试数据文件
- 保持题目标签和难度

### 测试用例 3：比赛复制

**目标**: 验证比赛和作业复制

```bash
node src/script/test-domain-copy.js \
  --source=training_domain \
  --target=test_contests \
  --problems \
  --contests \
  --cleanup
```

**预期结果**:
- 复制题目到新域
- 复制比赛配置
- 题目ID映射正确
- 比赛时间和规则保持

### 测试用例 4：完整域复制

**目标**: 验证所有功能的完整复制

```bash
node src/script/test-domain-copy.js \
  --source=full_domain \
  --target=test_complete \
  --problems \
  --contests \
  --trainings \
  --users \
  --groups \
  --discussions \
  --solutions \
  --cleanup
```

**预期结果**:
- 所有内容都被正确复制
- 用户权限和分组保持
- 讨论和题解正确关联
- 训练计划DAG结构完整

## 性能测试

### 大规模域复制测试

```bash
# 测试大量题目复制（建议先进行干运行）
node src/script/test-domain-copy.js \
  --source=large_problemset \
  --target=test_performance \
  --problems \
  --dry-run

# 实际执行（如果干运行结果满意）
node src/script/test-domain-copy.js \
  --source=large_problemset \
  --target=test_performance \
  --problems \
  --cleanup
```

### 性能指标监控

在测试过程中监控以下指标：

1. **内存使用**: 复制过程中的内存峰值
2. **执行时间**: 不同内容量的复制耗时
3. **网络流量**: 文件复制的网络开销
4. **数据库负载**: MongoDB的读写压力

## 单元测试

运行自动化单元测试：

```bash
# 运行域复制相关测试
npm test -- --grep "Domain Copy"

# 运行完整测试套件
npm test src/test/domain-copy.test.ts
```

## 故障排除

### 常见问题

1. **目标域已存在**
   ```
   Error: Target domain already exists
   ```
   解决：选择不同的目标域ID或先删除现有域

2. **源域不存在**
   ```
   Error: Source domain not found
   ```
   解决：检查源域ID是否正确

3. **权限不足**
   ```
   Error: Access denied
   ```
   解决：确保用户具有系统管理员权限

4. **文件复制失败**
   ```
   Warning: Failed to copy data file
   ```
   解决：检查存储系统状态和网络连接

### 日志分析

查看详细日志：

```bash
# 查看Hydro应用日志
tail -f logs/hydro.log | grep "domain-copy"

# 查看MongoDB日志
tail -f /var/log/mongodb/mongod.log
```

## 最佳实践

### 1. 生产环境使用建议

- 在非高峰时段进行大规模复制
- 先使用 `--dry-run` 评估复制规模
- 对重要域进行备份
- 分批复制大量内容

### 2. 测试环境建议

- 使用 `--cleanup` 自动清理测试数据
- 设置专门的测试域进行功能验证
- 定期运行自动化测试

### 3. 性能优化

- 对于大文件，考虑异步复制
- 使用事务确保数据一致性
- 合理设置复制超时时间

## API参考

### 复制选项

| 选项 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| copyProblems | boolean | true | 复制题库 |
| copyContests | boolean | true | 复制比赛 |
| copyTrainings | boolean | true | 复制训练 |
| copyUsers | boolean | false | 复制用户权限 |
| copyGroups | boolean | false | 复制用户分组 |
| copyDiscussions | boolean | false | 复制讨论 |
| copyProblemSolutions | boolean | false | 复制题解 |
| preserveIds | boolean | false | 保持题目ID |
| nameMapping | object | {} | 题目ID映射 |

### 进度回调

复制过程中会发送进度更新：

```typescript
interface CopyProgress {
    current: number;    // 当前完成步骤
    total: number;      // 总步骤数
    stage: string;      // 当前阶段描述
    detail?: string;    // 详细信息
}
```

## 版本历史

- v1.0.0: 基础域复制功能
- v1.1.0: 添加题目ID映射功能
- v1.2.0: 支持文件复制和验证
- v1.3.0: 添加进度反馈和错误处理

## 支持

如遇问题，请查看：
1. [Hydro官方文档](https://hydro.js.org/)
2. [GitHub Issues](https://github.com/hydro-dev/Hydro/issues)
3. 联系开发团队