import React from 'react';
import { createRoot } from 'react-dom/client';
import { NamedPage } from 'vj/misc/Page';

interface Command {
  operation: string;
  uid: number;
  node?: number;
  allow?: boolean;
  reset?: boolean;
  unrank?: boolean;
  clear?: boolean;
}
interface Failure {
  command: Command;
  label: string;
}
async function request(body?: Command) {
  const response = await fetch(window.location.pathname, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok || response.redirected || data.error) throw new Error(data.error?.message || '请求失败，请核实后重试。');
  return data;
}

// Hydro mounts this through NamedPage rather than a React refresh entry.
// eslint-disable-next-line react-refresh/only-export-components
function CourseManageApp() {
  const [data, setData] = React.useState<any>(null);
  const [error, setError] = React.useState('');
  const [tab, setTab] = React.useState('students');
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState('');
  const [failures, setFailures] = React.useState<Failure[]>([]);
  const [confirmation, setConfirmation] = React.useState<{ title: string, commands: Command[], uids: number[] } | null>(null);
  const load = React.useCallback(async () => {
    try {
      setData(await request());
      setError('');
    } catch (failure) {
      setError(failure.message);
    }
  }, []);
  React.useEffect(() => {
    load();
  }, [load]);
  const name = (uid: number) => data?.udict[uid]?.displayName || data?.udict[uid]?.uname || `UID ${uid}`;
  const all = data ? [...new Set<number>([...data.group.students, ...data.extraStudents])] : [];
  const run = async (commands: Command[]) => {
    if (busy) return;
    setBusy(true);
    setConfirmation(null);
    const failed: Failure[] = [];
    let success = 0;
    for (const command of commands) {
      try {
        // Collect every student result; refresh the page data once after the batch.

        const result = await request(command);
        if (!Array.isArray(result.results)) throw new Error('未收到逐人处理结果');
        for (const item of result.results) {
          if (item.success) success++;
          else {
            failed.push({
              command: { ...command, uid: item.uid },
              label: name(item.uid) + (command.node ? ` · 课时编号 ${command.node}` : ''),
            });
          }
        }
      } catch (failure) {
        failed.push({ command, label: `${command.uid ? name(command.uid) : '本批次'}：${failure.message}` });
      }
    }
    setFailures(failed);
    setNotice(`已确认成功 ${success} 项；需核实或重试 ${failed.length} 项。`);
    await load();
    setBusy(false);
  };
  if (!data) return <p role="status">{error || '正在加载课程管理…'}</p>;
  const base = window.location.pathname.replace(/\/manage$/, '');
  const dag = data.tdoc.dag || [];
  const confirm = (title: string, commands: Command[], uids = all) => setConfirmation({ title, commands, uids });
  const nodeCommands = (operation: string, allow: boolean, reset = false): Command[] =>
    dag.map((node) => ({
      operation,
      node: node._id,
      uid: 0,
      allow,
      reset,
    }));
  const memberTable = (uids: number[]) => (
    <table className="data-table">
      <thead>
        <tr>
          <th>学生</th>
          <th>课程认领</th>
          <th>排名设置</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        {uids.map((uid) => {
          const status = data.tsdict[uid];
          return (
            <tr key={uid}>
              <td>
                <strong>{name(uid)}</strong>
                <br />
                <span className="supplementary">UID {uid}</span>
              </td>
              <td>{status?.attend ? '已认领' : '未认领'}</td>
              <td>{status?.unrank ? '不参与排名' : '参与排名'}</td>
              <td>
                <button
                  type="button"
                  className="button compact"
                  disabled={busy}
                  onClick={() =>
                    status?.attend
                      ? confirm(`取消 ${name(uid)} 的课程认领`, [{ operation: 'visit', uid, allow: false }], [uid])
                      : run([{ operation: 'visit', uid, allow: true }])}
                >
                  {status?.attend ? '取消认领' : '代认领'}
                </button>
                {status?.attend ? (
                  <button
                    type="button"
                    className="button compact"
                    disabled={busy}
                    onClick={() => run([{ operation: 'unrank', uid, unrank: !status.unrank }])}
                  >
                    {status.unrank ? '恢复排名' : '不参与排名'}
                  </button>
                ) : null}
              </td>
            </tr>
          );
        })}
        {!uids.length ? (
          <tr>
            <td colSpan={4}>当前没有学生。</td>
          </tr>
        ) : null}
      </tbody>
    </table>
  );
  return (
    <div className="course-manage-app">
      <p className="supplementary">管理课程参与、排名和访问设置。课堂观察请使用“课程反馈”。</p>
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {failures.length ? (
        <div>
          <ul>
            {failures.map((failure, index) => (
              <li key={index}>{failure.label}</li>
            ))}
          </ul>
          <button
            type="button"
            className="button primary compact"
            disabled={busy}
            onClick={() => run(failures.map((failure) => failure.command))}
          >
            只重试以上失败项
          </button>
        </div>
      ) : null}
      {confirmation ? (
        <section className="section" aria-label="确认批量操作">
          <div className="section__body">
            <h2>{confirmation.title}</h2>
            <p>课程：{data.tdoc.title}</p>
            <p>
              范围：
              {confirmation.commands.some((command) => command.node !== undefined)
                ? confirmation.commands.map((command) => dag.find((node) => node._id === command.node)?.title).join('、')
                : '本课程'}
            </p>
            <p>
              对象：{confirmation.uids.length} 人 · {confirmation.uids.map(name).join('、')}
            </p>
            <p className="supplementary">恢复访问规则只清除手工访问设置，保留提交、成绩和课堂观察。</p>
            <button type="button" className="button primary" disabled={busy} onClick={() => run(confirmation.commands)}>
              确认执行
            </button>
            <button type="button" className="button" onClick={() => setConfirmation(null)}>
              取消
            </button>
          </div>
        </section>
      ) : null}
      <div className="course-manage-tabs" role="tablist">
        {[
          ['students', '班级成员'],
          ['extra', '临时调课学生'],
          ['nodes', '课时访问设置'],
        ].map(([value, label]) => (
          <button
            type="button"
            role="tab"
            key={value}
            aria-selected={tab === value}
            className={`course-manage-tab${tab === value ? ' active' : ''}`}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'students' ? (
        <>
          <div className="button-group">
            <button
              type="button"
              className="button compact"
              disabled={busy}
              onClick={() => confirm('批量代认领：仅班级成员', [{ operation: 'visit', uid: 0, allow: true }], data.group.students)}
            >
              批量代认领
            </button>
            <button
              type="button"
              className="button compact"
              disabled={busy}
              onClick={() => confirm('取消认领：仅班级成员', [{ operation: 'visit', uid: 0, allow: false }], data.group.students)}
            >
              批量取消认领
            </button>
            <button
              type="button"
              className="button compact"
              disabled={busy}
              onClick={() => confirm('设为不参与排名：全课程名单（含临时学生）', [{ operation: 'unrank', uid: 0, unrank: true }])}
            >
              全课程不参与排名
            </button>
            <button
              type="button"
              className="button compact"
              disabled={busy}
              onClick={() => confirm('恢复排名：全课程名单（含临时学生）', [{ operation: 'unrank', uid: 0, clear: true }])}
            >
              全课程恢复排名
            </button>
          </div>
          {memberTable(data.group.students)}
        </>
      ) : null}
      {tab === 'extra' ? (
        <>
          <p>
            <a className="button compact" href={`${base}/edit`}>
              编辑临时学生名单
            </a>
          </p>
          {memberTable(data.extraStudents)}
        </>
      ) : null}
      {tab === 'nodes' ? (
        <>
          <p className="supplementary">可访问人数 / 当前课程名单 {all.length} 人（含临时、未认领学生）。按实际访问规则计算。</p>
          <div className="button-group">
            {[
              ['allowLecture', '讲义'],
              ['allowUser', '题目'],
            ].flatMap(([operation, label]) =>
              [true, false].map((allow) => (
                <button
                  type="button"
                  className="button compact"
                  key={operation + allow}
                  disabled={busy || !all.length}
                  onClick={() => confirm(`${allow ? '开放' : '关闭'}全部课时${label}`, nodeCommands(operation, allow))}
                >
                  {allow ? '开放' : '关闭'}全部{label}
                </button>
              )),
            )}
            <button
              type="button"
              className="button compact"
              disabled={busy || !all.length}
              onClick={() => confirm('全部课时题目恢复规则', nodeCommands('allowUser', false, true))}
            >
              全部题目恢复规则
            </button>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>课时</th>
                <th>讲义内容 / 访问</th>
                <th>题目访问</th>
                <th>统一操作</th>
              </tr>
            </thead>
            <tbody>
              {dag.map((node, index) => {
                const counts = data.accessCounts[node._id];
                return (
                  <tr key={node._id}>
                    <td>
                      {index + 1}. {node.title}
                    </td>
                    <td>
                      {node.lecture || data.tdoc.lecture?.[node._id] ? '有内容' : '无内容'} · {counts.lecture}/{counts.total} 人可访问
                      <br />
                      <a href={`${base}/lecture/${node._id}?edit=1`}>编辑讲义</a>
                    </td>
                    <td>
                      {counts.problems}/{counts.total} 人可访问
                      <br />P{node.pids.join('、P')}
                    </td>
                    <td>
                      {[
                        ['allowLecture', '讲义'],
                        ['allowUser', '题目'],
                      ].flatMap(([operation, label]) =>
                        [true, false].map((allow) => (
                          <button
                            type="button"
                            className="button compact"
                            key={operation + allow}
                            disabled={busy || !all.length}
                            onClick={() =>
                              confirm(`${(allow ? '开放' : '关闭') + label}：${node.title}`, [{ operation, node: node._id, uid: 0, allow }])}
                          >
                            {allow ? '开放' : '关闭'}
                            {label}
                          </button>
                        )),
                      )}
                      <button
                        type="button"
                        className="button compact"
                        disabled={busy || !all.length}
                        onClick={() =>
                          confirm(`恢复题目规则：${node.title}`, [{ operation: 'allowUser', node: node._id, uid: 0, reset: true }])}
                      >
                        题目恢复规则
                      </button>
                      <button
                        type="button"
                        className="button compact"
                        disabled={busy || !all.length}
                        onClick={() =>
                          confirm(`恢复讲义规则：${node.title}`, [{ operation: 'allowLecture', node: node._id, uid: 0, reset: true }])}
                      >
                        讲义恢复规则
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      ) : null}
    </div>
  );
}

export default new NamedPage('course_manage', () => {
  const container = document.getElementById('course');
  if (container) createRoot(container).render(<CourseManageApp />);
});
