/**
 * 比赛/作业统计插件
 * ------------------
 * 该 Handler 会针对某个用户组汇总比赛/作业进度，并提供 HTML 页面
 * 与 CSV 导出。大部分逻辑集中在同一个文件中，方便审计与部署。
 */
import { stringify as toCSV } from 'csv-stringify/sync';
import {
    BadRequestError,
    ContestModel,
    Context,
    Handler,
    NotAssignedError,
    PERM,
    STATUS,
    Types,
    UserModel,
    param,
} from 'hydrooj';

interface StatCell {
    display: string;
}

// 表格中单行记录的数据结构。
interface StatRow {
    tdoc: any;
    cells: StatCell[];
}

// 表头信息（标题 + 可选链接）。
interface TableHeader {
    label: string;
    url?: string;
    scoreboardUrl?: string;
}

// 统计表格行（行标题 + 单元格文本）。
interface TableRow {
    label: string;
    url?: string;
    scoreboardUrl?: string;
    cells: string[];
}

// 前端渲染所需的表格结构。
interface TableData {
    rowHeaderLabel: string;
    headers: TableHeader[];
    rows: TableRow[];
}

// Windows 文件名不可包含的字符需要提前替换，避免导出失败。
const sanitizeFilename = (name: string) => name.replace(/[\/:*?"<>|]+/g, '_');

/**
 * 遍历 tsdoc 的提交日志并汇总进度，仅统计 tdoc.pids 内的题目。
 */
const buildCounts = (tdoc: any, tsdoc: any) => {
    const submitted = new Set<number>();
    const accepted = new Set<number>();
    for (const j of tsdoc?.journal || []) {
        if (!tdoc.pids?.includes(j.pid)) continue;
        submitted.add(j.pid);
        if (j.status === STATUS.STATUS_ACCEPTED) accepted.add(j.pid);
    }
    const total = tdoc.pids?.length || 0;
    const acCount = accepted.size;
    const submittedCount = submitted.size;
    const submitNotAc = Math.max(0, submittedCount - acCount);
    const notSubmitted = Math.max(0, total - submittedCount);
    return {
        acCount,
        submitNotAc,
        notSubmitted,
    };
};

/**
 * 不同赛制记录的分数字段不同，此处统一转换为单一可比较的数值，
 * 便于后续展示逻辑保持简单。
 */
const resolveScore = (tsdoc: any) => {
    if (!tsdoc) return 0;
    if (typeof tsdoc.penaltyScore === 'number') return tsdoc.penaltyScore;
    if (typeof tsdoc.score === 'number') return tsdoc.score;
    if (typeof tsdoc.accept === 'number') return tsdoc.accept;
    return 0;
};

const buildActivityStats = (tdoc: any, tsdoc: any) => {
    const { acCount, submitNotAc, notSubmitted } = buildCounts(tdoc, tsdoc);
    let lastSubmitAt: Date | null = null;
    for (const j of tsdoc?.journal || []) {
        if (!tdoc.pids?.includes(j.pid)) continue;
        const submitAt = j.rid?.getTimestamp?.();
        if (submitAt && (!lastSubmitAt || submitAt > lastSubmitAt)) lastSubmitAt = submitAt;
    }
    return {
        totalScore: resolveScore(tsdoc),
        acCount,
        submitNotAc,
        notSubmitted,
        lastSubmitAt,
    };
};

/**
 * 构造表格中的单个单元格：ACM 赛制直接显示 "AC/未AC/未提交"；
 * 其他赛制则显示总分并附带同样的计数，便于非 ACM 场景理解。
 */
const buildCell = (tdoc: any, tsdoc: any): StatCell => {
    const { acCount, submitNotAc, notSubmitted } = buildCounts(tdoc, tsdoc);
    if (tdoc.rule === 'acm') {
        return { display: `${acCount}/${submitNotAc}/${notSubmitted}` };
    }
    const totalScore = resolveScore(tsdoc);
    return { display: `${totalScore} (${acCount}/${submitNotAc}/${notSubmitted})` };
};

/**
 * 批量拉取指定比赛/作业与用户的状态，构建二维矩阵。通过一次性
 * 查询避免在 MongoDB 上触发 N+1 请求。
 */
const buildRows = async (domainId: string, tdocs: any[], userIds: number[]) => {
    if (!tdocs.length) return [] as StatRow[];
    const tsdict: Record<string, Record<number, any>> = {};
    if (userIds.length) {
        const tids = tdocs.map((tdoc) => tdoc.docId);
        const tsdocs = await ContestModel.getMultiStatus(domainId, {
            docId: { $in: tids },
            uid: { $in: userIds },
        }).toArray() as any[];
        for (const tsdoc of tsdocs) {
            const tid = typeof tsdoc.docId === 'string' ? tsdoc.docId : tsdoc.docId.toHexString();
            tsdict[tid] ||= {};
            tsdict[tid][tsdoc.uid] = tsdoc;
        }
    }
    return tdocs.map((tdoc) => {
        const tid = typeof tdoc.docId === 'string' ? tdoc.docId : tdoc.docId.toHexString();
        const cells = userIds.map((uid) => buildCell(tdoc, tsdict[tid]?.[uid]));
        return { tdoc, cells };
    });
};

/**
 * 根据 layout 生成表格数据：item 表示比赛/作业为行，user 表示用户为行。
 */
const buildTableData = (
    layout: 'item' | 'user',
    tdocs: any[],
    users: any[],
    rows: StatRow[],
    options: {
        itemLabel: string;
        itemUrl: (tdoc: any) => string;
        itemScoreboardUrl: (tdoc: any) => string;
        userUrl: (user: any) => string;
    },
): TableData => {
    const itemHeaders = tdocs.map((tdoc) => ({
        label: tdoc.title,
        url: options.itemUrl(tdoc),
        scoreboardUrl: options.itemScoreboardUrl(tdoc),
    }));
    const userHeaders = users.map((user) => ({
        label: user.uname,
        url: options.userUrl(user),
    }));
    if (layout === 'user') {
        return {
            rowHeaderLabel: '用户',
            headers: itemHeaders,
            rows: users.map((user, index) => ({
                label: user.uname,
                url: options.userUrl(user),
                cells: rows.map((row) => row.cells[index]?.display || ''),
            })),
        };
    }
    return {
        rowHeaderLabel: options.itemLabel,
        headers: userHeaders,
        rows: rows.map((row, index) => ({
            label: row.tdoc.title,
            url: itemHeaders[index]?.url,
            scoreboardUrl: itemHeaders[index]?.scoreboardUrl,
            cells: row.cells.map((cell) => cell.display),
        })),
    };
};

/**
 * 比赛/作业共用的 CSV 导出辅助函数。添加 UTF-8 BOM 以确保 Excel
 * 打开时不会出现乱码。
 */
const buildCsv = (table: TableData) => {
    const header = [table.rowHeaderLabel, ...table.headers.map((item) => item.label)];
    const data = table.rows.map((row) => [row.label, ...row.cells]);
    return toCSV([header, ...data], { bom: true });
};

class ContestStatsHandler extends Handler {
    // 查询参数与内置比赛列表保持一致，便于管理员理解。
    @param('rule', Types.Range(ContestModel.RULES), true)
    @param('group', Types.Name, true)
    @param('page', Types.PositiveInt, true)
    @param('q', Types.String, true)
    @param('layout', Types.Range(['item', 'user']), true)
    @param('download', Types.Boolean, true)
    async get(domainId: string, rule = '', group = '', page = 1, q = '', layout = '', download = false) {
        if (rule && ContestModel.RULES[rule].hidden) throw new BadRequestError();
        // listGroup 返回用户可见的所有分组，这里过滤纯数字命名的临时课堂。
        const groupDocs = await UserModel.listGroup(
            domainId,
            this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_CONTEST) ? undefined : this.user._id,
        ) as any[];
        const groups = groupDocs.map((doc: any) => doc.name).filter((name: string) => !Number.isSafeInteger(+name));
        if (!groups.length) {
            const emptyTable: TableData = { rowHeaderLabel: '比赛', headers: [], rows: [] };
            this.response.template = 'contest_statistics.html';
            this.response.body = {
                rows: [],
                users: [],
                groups: [],
                group: '',
                rule,
                q,
                layout: 'item',
                table: emptyTable,
                page: 1,
                tpcount: 1,
                qs: '',
            };
            return;
        }
        const selectedGroup = group || groups[0];
        if (!groups.includes(selectedGroup)) throw new NotAssignedError(selectedGroup);
        const groupDoc = groupDocs.find((doc: any) => doc.name === selectedGroup);
        const groupUids = Array.from(new Set(groupDoc?.uids || []));
        const udict = await UserModel.getList(domainId, groupUids);
        const users = groupUids
            .map((uid) => udict[uid])
            .filter(Boolean)
            .sort((a, b) => a.uname.localeCompare(b.uname));
        const normalizedQuery = q.trim().toLowerCase();
        const filteredUsers = normalizedQuery
            ? users.filter((user) => user.uname.toLowerCase().includes(normalizedQuery))
            : users;
        const userIds = filteredUsers.map((user) => user._id);

        const rules = Object.keys(ContestModel.RULES).filter((key) => !ContestModel.RULES[key].hidden);
        const filter = {
            assign: { $in: [selectedGroup] },
            ...(rule ? { rule } : { rule: { $in: rules } }),
        };
        const sort = { endAt: -1, beginAt: -1, _id: -1 };
        const cursor = ContestModel.getMulti(domainId, filter).sort(sort);
        const [tdocs, tpcount] = await this.paginate(cursor, page, 'contest');
        const exportDocs = download
            ? await ContestModel.getMulti(domainId, filter).sort(sort).toArray()
            : tdocs;
        const rows = await buildRows(domainId, exportDocs, userIds);
        const hasExplicitLayout = layout === 'user' || layout === 'item';
        let resolvedLayout: 'user' | 'item';
        if (hasExplicitLayout) {
            resolvedLayout = layout as 'user' | 'item';
        } else if (normalizedQuery) {
            resolvedLayout = 'item';
        } else {
            resolvedLayout = 'item';
        }
        const table = buildTableData(resolvedLayout, exportDocs, filteredUsers, rows, {
            itemLabel: '比赛',
            itemUrl: (tdoc) => (this as any).url('contest_detail', { tid: tdoc.docId }),
            itemScoreboardUrl: (tdoc) => (this as any).url('contest_scoreboard', { tid: tdoc.docId }),
            userUrl: (user) => (this as any).url('user_detail', { uid: user._id }),
        });
        if (download) {
            const suffix = rule ? `-${sanitizeFilename(rule)}` : '';
            const filename = `contest-stats-${sanitizeFilename(selectedGroup)}${suffix}.csv`;
            this.binary(buildCsv(table), filename);
            return;
        }
        let qs = rule ? `rule=${rule}` : '';
        if (selectedGroup) qs += qs ? `&group=${selectedGroup}` : `group=${selectedGroup}`;
        if (q) qs += `${qs ? '&' : ''}q=${encodeURIComponent(q)}`;
        qs += `${qs ? '&' : ''}layout=${resolvedLayout}`;
        this.response.template = 'contest_statistics.html';
        this.response.body = {
            rows,
            users: filteredUsers,
            groups,
            group: selectedGroup,
            rule,
            q,
            layout: resolvedLayout,
            table,
            page,
            tpcount,
            qs,
        };
    }
}

class HomeworkStatsHandler extends Handler {
    // 查询参数与 ContestStatsHandler 相同，但仅处理 rule === 'homework'。
    @param('group', Types.Name, true)
    @param('page', Types.PositiveInt, true)
    @param('q', Types.String, true)
    @param('layout', Types.Range(['item', 'user']), true)
    @param('download', Types.Boolean, true)
    async get(domainId: string, group = '', page = 1, q = '', layout = '', download = false) {
        const groupDocs = await UserModel.listGroup(
            domainId,
            this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK) ? undefined : this.user._id,
        ) as any[];
        const groups = groupDocs.map((doc: any) => doc.name).filter((name: string) => !Number.isSafeInteger(+name));
        if (!groups.length) {
            const emptyTable: TableData = { rowHeaderLabel: '作业', headers: [], rows: [] };
            this.response.template = 'homework_statistics.html';
            this.response.body = {
                rows: [],
                users: [],
                groups: [],
                group: '',
                q,
                layout: 'item',
                table: emptyTable,
                page: 1,
                tpcount: 1,
                qs: '',
            };
            return;
        }
        const selectedGroup = group || groups[0];
        if (!groups.includes(selectedGroup)) throw new NotAssignedError(selectedGroup);
        const groupDoc = groupDocs.find((doc: any) => doc.name === selectedGroup);
        const groupUids = Array.from(new Set(groupDoc?.uids || []));
        const udict = await UserModel.getList(domainId, groupUids);
        const users = groupUids
            .map((uid) => udict[uid])
            .filter(Boolean)
            .sort((a, b) => a.uname.localeCompare(b.uname));
        const normalizedQuery = q.trim().toLowerCase();
        const filteredUsers = normalizedQuery
            ? users.filter((user) => user.uname.toLowerCase().includes(normalizedQuery))
            : users;
        const userIds = filteredUsers.map((user) => user._id);

        const filter = {
            rule: 'homework',
            assign: { $in: [selectedGroup] },
        };
        const sort = { penaltySince: -1, endAt: -1, beginAt: -1, _id: -1 };
        const cursor = ContestModel.getMulti(domainId, filter).sort(sort);
        const [tdocs, tpcount] = await this.paginate(cursor, page, 'contest');
        const exportDocs = download
            ? await ContestModel.getMulti(domainId, filter).sort(sort).toArray()
            : tdocs;
        const rows = await buildRows(domainId, exportDocs, userIds);
        const hasExplicitLayout = layout === 'user' || layout === 'item';
        let resolvedLayout: 'user' | 'item';
        if (hasExplicitLayout) {
            resolvedLayout = layout as 'user' | 'item';
        } else if (normalizedQuery) {
            resolvedLayout = 'item';
        } else {
            resolvedLayout = (filteredUsers.length > exportDocs.length ? 'user' : 'item');
        }
        const table = buildTableData(resolvedLayout, exportDocs, filteredUsers, rows, {
            itemLabel: '作业',
            itemUrl: (tdoc) => (this as any).url('homework_detail', { tid: tdoc.docId }),
            itemScoreboardUrl: (tdoc) => (this as any).url('homework_scoreboard', { tid: tdoc.docId }),
            userUrl: (user) => (this as any).url('user_detail', { uid: user._id }),
        });
        if (download) {
            const filename = `homework-stats-${sanitizeFilename(selectedGroup)}.csv`;
            this.binary(buildCsv(table), filename);
            return;
        }
        let qs = selectedGroup ? `group=${selectedGroup}` : '';
        if (q) qs += `${qs ? '&' : ''}q=${encodeURIComponent(q)}`;
        qs += `${qs ? '&' : ''}layout=${resolvedLayout}`;
        this.response.template = 'homework_statistics.html';
        this.response.body = {
            rows,
            users: filteredUsers,
            groups,
            group: selectedGroup,
            q,
            layout: resolvedLayout,
            table,
            page,
            tpcount,
            qs,
        };
    }
}

/**
 * 注册服务端路由。通过模板覆盖（contest_main/homework_main）注入按钮，
 * 指向这里定义的统计页。
 */
export async function apply(ctx: Context) {
    ctx.Route('contest_statistics', '/contest-statistics', ContestStatsHandler, PERM.PERM_CREATE_CONTEST);
    ctx.Route('homework_statistics', '/homework-statistics', HomeworkStatsHandler, PERM.PERM_CREATE_HOMEWORK);
    ctx.on('handler/after/UserDetail#get', async (handler: Handler) => {
        if (handler.response?.template !== 'user_detail.html') return;
        const body = handler.response.body as any;
        if (!body?.tdocs?.length) return;
        const showActivityStats = handler.user.hasPerm(PERM.PERM_CREATE_HOMEWORK);
        body.showActivityStats = showActivityStats;
        if (!showActivityStats) return;
        const domainId = handler.args?.domainId;
        const uid = body?.udoc?._id ?? handler.args?.uid;
        if (!domainId || !uid) return;
        const docIds = body.tdocs.map((tdoc: any) => tdoc.docId).filter(Boolean);
        if (!docIds.length) return;
        const [tsdocs, fullTdocs] = await Promise.all([
            ContestModel.getMultiStatus(domainId, { docId: { $in: docIds }, uid }).toArray(),
            ContestModel.getMulti(domainId, { docId: { $in: docIds } })
                .project({ docId: 1, title: 1, rule: 1, pids: 1 })
                .toArray(),
        ]);
        const statusMap = new Map<string, any>();
        for (const tsdoc of tsdocs) {
            const key = typeof tsdoc.docId === 'string' ? tsdoc.docId : tsdoc.docId.toHexString();
            statusMap.set(key, tsdoc);
        }
        const tdocMap = new Map<string, any>();
        for (const tdoc of fullTdocs) {
            const key = typeof tdoc.docId === 'string' ? tdoc.docId : tdoc.docId.toHexString();
            tdocMap.set(key, tdoc);
        }
        for (const tdoc of body.tdocs) {
            const key = typeof tdoc.docId === 'string' ? tdoc.docId : tdoc.docId.toHexString();
            const fullTdoc = tdocMap.get(key) || tdoc;
            tdoc.activityStats = buildActivityStats(fullTdoc, statusMap.get(key));
        }
    });
}
