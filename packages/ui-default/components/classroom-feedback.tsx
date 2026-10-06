import React from 'react';
import { v4 as uuid } from 'uuid';
import { feedbackState } from './classroom-feedback-state';

const kinds = { GUIDED: '指导过', CHECKED: '核对过', NEEDS_RETEST: '需复测' };
const details = {
  GUIDED: { IDEA: '思路', DEBUGGING: '调试' },
  CHECKED: { REASONING: '关键思路', BOUNDARY: '边界', CODE_EXPLANATION: '代码解释' },
  NEEDS_RETEST: { UNDERSTANDING: '题意理解', BOUNDARY: '边界', TRANSFER: '迁移' },
};
const states = { active: '已记录', pending: '待跟进', resolved: '已跟进', retracted: '已撤销' };
export interface FeedbackTarget {
  studentUid: number;
  pid: number;
  nodeId?: number;
  rid?: string;
}

async function read(url: string) {
  const response = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
  if (!response.ok || response.redirected) throw new Error('无法查询，请确认登录和授课权限后重试。');
  const data = await response.json();
  if (data.error || !Array.isArray(data.items)) throw new Error('查询失败，请重试。');
  return data;
}

export default function ClassroomFeedback({ url, compact = false, target, recordingUnavailable = false }: {
  url: string; compact?: boolean; target?: FeedbackTarget; recordingUnavailable?: boolean;
}) {
  const endpoint = new URL(url.split('?')[0], window.location.href).href;
  const store = React.useMemo(() => feedbackState(endpoint), [endpoint]);
  React.useSyncExternalStore(store.subscribe, store.snapshot);
  const params = React.useMemo(() => new URL(url, window.location.href).searchParams, [url]);
  const targetKey = [target?.studentUid || params.get('studentUid'), target?.pid || params.get('pid')].join(':');
  const [view, setView] = React.useState(params.get('view') || 'roster');
  const [nodeId, setNodeId] = React.useState(
    target?.nodeId !== undefined ? String(target.nodeId) : params.get('nodeId') || store.lessonSelections.get(targetKey) || '',
  );
  const [pid, setPid] = React.useState(String(target?.pid || params.get('pid') || ''));
  const [focusUid, setFocusUid] = React.useState(target?.studentUid || Number(params.get('studentUid')) || 0);
  const [data, setData] = React.useState<any>(null);
  const [search, setSearch] = React.useState('');
  const [expanded, setExpanded] = React.useState(0);
  const [detailEvent, setDetailEvent] = React.useState<any>(null);
  const [loadError, setLoadError] = React.useState('');
  const loadId = React.useRef(0);
  const initialized = React.useRef(false);
  const filterKey = [view, nodeId, pid, focusUid].join(':');
  const ready = data?.filterKey === filterKey && data?.confirmed === store.confirmed;
  const identityChanged = !!data && !!store.operatorUid && data.operatorUid !== store.operatorUid;
  const locked = store.busy || !!store.pending || identityChanged || recordingUnavailable;
  const load = React.useCallback(
    async (before = '') => {
      const id = ++loadId.current;
      const confirmed = store.confirmed;
      const query = new URLSearchParams({ view });
      if (pid) query.set('pid', pid);
      if (nodeId !== '') query.set('nodeId', nodeId);
      if (focusUid) query.set('studentUid', String(focusUid));
      if (before) query.set('before', before);
      try {
        const payload = await read(`${endpoint}?${query}`);
        if (id !== loadId.current) return;
        if (store.operatorUid && store.operatorUid !== payload.operatorUid && !store.pending) {
          store.drafts.clear();
          store.lessonSelections.clear();
          store.undo = null;
        }
        if (!store.pending || !store.operatorUid) store.operatorUid = payload.operatorUid;
        setData((previous) => ({ ...payload, filterKey, confirmed, items: before ? [...(previous?.items || []), ...payload.items] : payload.items }));
        setLoadError('');
        if (!initialized.current) {
          initialized.current = true;
          const candidates = payload.activity.nodes.filter((node) => node.pids.includes(Number(pid)));
          // Whole-course reused problems require explicit lesson selection.
          if (nodeId === '' && candidates.length === 1) {
            setNodeId(String(candidates[0]._id));
            store.lessonSelections.set(targetKey, String(candidates[0]._id));
          }
          if (!pid && payload.activity.pids.length === 1) setPid(String(payload.activity.pids[0]));
        }
        if (detailEvent) {
          const fresh = await read(`${endpoint}/${encodeURIComponent(detailEvent._id)}`);
          if (id === loadId.current) {
            setDetailEvent(fresh.items[0]);
            setData((previous) => ({
              ...previous,
              submissions: { ...previous.submissions, ...fresh.submissions },
              latest: { ...previous.latest, ...fresh.latest },
              udict: { ...previous.udict, ...fresh.udict },
            }));
          }
        }
      } catch (error) {
        if (id === loadId.current) setLoadError(error.message);
      }
    },
    [endpoint, view, pid, nodeId, focusUid, store, detailEvent?._id],
  );
  React.useEffect(() => {
    load();
    return () => {
      loadId.current++;
    };
  }, [load, store.confirmed]);
  React.useEffect(() => {
    if (!data) return;
    document.querySelectorAll('[data-feedback-pending-count]').forEach((element) => {
      element.textContent = String(data.totalPending);
    });
  }, [data?.totalPending]);
  const userText = (uid: number) => data?.udict[uid]?.displayName || data?.udict[uid]?.uname || `UID ${uid}`;
  const problemText = (id: number) => data?.pdict[id]?.title || `P${id}`;
  const key = (uid: number) => [store.operatorUid, nodeId, pid, uid].join(':');
  const contextText = (event) =>
    `${event.context?.problemTitle || `P${event.pid}`} · ${
      event.context?.lessonTitle || (event.nodeId !== undefined ? `历史课时编号 ${event.nodeId}，名称未核实` : '作业')
    }`;
  const observe = (uid: number, kind: string) => {
    if (locked || !ready || !pid || (data.activity.activityType === 'course' && nodeId === '')) return;
    const draft = store.draft(key(uid));
    if ([...draft.note].length > 500 || (draft.detail && !draft.detail.startsWith(`${kind}:`))) {
      store.notice = [...draft.note].length > 500 ? '备注最多 500 字。' : '细项属于其他动作，请修改细项后保存。';
      store.tone = 'error';
      store.notify();
      return;
    }
    const rid = target?.rid || params.get('rid');
    store.send(
      {
        url: endpoint,
        label: `已记录：${userText(uid)} · ${problemText(Number(pid))} · ${kinds[kind]}`,
        undo: { eventId: '', action: 'retract', version: 0 },
        body: {
          requestId: uuid(),
          activityType: data.activity.activityType,
          activityId: data.activity.activityId,
          studentUid: uid,
          pid: Number(pid),
          kind,
          note: draft.note,
          ...(nodeId !== '' ? { nodeId: Number(nodeId) } : {}),
          ...(draft.detail ? { detail: draft.detail.split(':')[1] } : {}),
          ...(rid
          && Number(target?.pid || params.get('pid')) === Number(pid)
          && uid === Number(target?.studentUid || params.get('studentUid'))
            ? { rid }
            : {}),
        },
      },
      fetch,
      key(uid),
    );
  };
  const change = (event, action: string, resolutionId?: string) =>
    store.send({
      url: `${endpoint}/${encodeURIComponent(event._id)}/${action}`,
      body: { requestId: uuid(), expectedVersion: event.version, ...(resolutionId ? { resolutionId } : {}) },
      label: `${
        action === 'resolve' ? '已完成跟进' : action === 'undo-resolve' ? '已恢复待跟进' : '已撤销观察'
      }：${userText(event.studentUid)} · ${contextText(event)}`,
      ...(action === 'resolve' ? { undo: { eventId: event._id, action: 'undo-resolve', version: event.version + 1 } } : {}),
    });
  const undo = () => {
    if (!store.undo) return;
    const operation = store.undo;
    store.send({
      url: `${endpoint}/${encodeURIComponent(operation.eventId)}/${operation.action}`,
      body: {
        requestId: uuid(),
        expectedVersion: operation.version,
        ...(operation.resolutionId ? { resolutionId: operation.resolutionId } : {}),
      },
      label: operation.action === 'retract' ? '已撤销这次观察，原记录保留。' : '已撤销这次处理，恢复待跟进。',
    });
  };
  const roster =
    data?.roster.filter(
      (uid) =>
        (!focusUid || uid === focusUid)
        && `${userText(uid)} ${data.udict[uid]?.uname || ''} ${uid}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
    ) || [];
  const node = data?.activity.nodes.find((item) => String(item._id) === nodeId);
  const pids = node ? node.pids : data?.activity.pids || [];
  const submission = (rid: string, label: string) => {
    const entry = data?.submissions[rid];
    return (
      <span>
        {label}：
        {entry ? (
          <a href={entry.url}>
            {entry.score} 分 · {entry._id.slice(-6)}
          </a>
        ) : rid ? (
          '无查看权限或记录已不可用'
        ) : (
          '未关联'
        )}
      </span>
    );
  };
  const renderActions = (event) => (
    <span className="cf-event-actions">
      {event.state === 'pending' ? (
        <button type="button" className="button primary compact" disabled={locked} onClick={() => change(event, 'resolve')}>
          完成跟进
        </button>
      ) : null}
      {event.state === 'resolved' && (data.manager || event.resolution?.operatorUid === data.operatorUid) ? (
        <button
          type="button"
          className="button compact"
          disabled={locked}
          onClick={() => change(event, 'undo-resolve', event.resolution._id)}
        >
          撤销这次处理
        </button>
      ) : null}
      <button
        type="button"
        className="button compact"
        disabled={locked}
        onClick={async () => {
          try {
            const payload = await read(`${endpoint}/${encodeURIComponent(event._id)}`);
            setDetailEvent(payload.items[0]);
            setData((previous) => ({
              ...previous,
              submissions: { ...previous.submissions, ...payload.submissions },
              latest: { ...previous.latest, ...payload.latest },
              udict: { ...previous.udict, ...payload.udict },
            }));
          } catch (error) {
            setLoadError(error.message);
          }
        }}
      >
        详情
      </button>
    </span>
  );

  return (
    <div className={`classroom-feedback${compact ? ' classroom-feedback--compact' : ''}`}>
      {!compact ? (
        <div className="cf-tabs" role="tablist" aria-label="课程反馈视图">
          {(
            [
              ['roster', '名单录入'],
              ['history', '观察历史'],
              ['pending', '待复测'],
            ] as const
          ).map(([value, label]) => (
            <button
              type="button"
              key={value}
              role="tab"
              aria-selected={view === value}
              className={view === value ? 'active' : ''}
              disabled={locked}
              onClick={() => {
                setView(value);
                setDetailEvent(null);
              }}
            >
              {label}
              {value === 'pending' && data ? ` (${data.totalPending})` : ''}
            </button>
          ))}
        </div>
      ) : null}
      <div className="cf-toolbar">
        {data?.activity.activityType === 'course' ? (
          <label>
            课时
            <select
              className="select"
              aria-label="课时"
              value={nodeId}
              disabled={locked}
              onChange={(event) => {
                setNodeId(event.target.value);
                store.lessonSelections.set(targetKey, event.target.value);
                const selected = data.activity.nodes.find((item) => String(item._id) === event.target.value);
                if (selected && !selected.pids.includes(Number(pid))) setPid('');
              }}
            >
              <option value="">{view === 'roster' ? '请选择课时' : '全部课时（含历史）'}</option>
              {data.activity.nodes.map((item, index) => (
                <option key={item._id} value={item._id}>
                  {index + 1}. {item.title}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label>
          题目
          <select className="select" aria-label="题目" value={pid} disabled={locked} onChange={(event) => setPid(event.target.value)}>
            <option value="">{view === 'roster' ? '请选择题目' : '全部题目（含历史）'}</option>
            {pids.map((problemId) => (
              <option key={problemId} value={problemId}>
                P{problemId} · {problemText(problemId)}
              </option>
            ))}
          </select>
        </label>
        {!compact && view === 'roster' ? (
          <label>
            学生
            <input
              className="textbox"
              type="search"
              value={search}
              placeholder="姓名、用户名或 UID"
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        ) : null}
        {!compact && view !== 'roster' && data ? (
          <label>
            学生
            <select
              className="select"
              aria-label="筛选学生"
              value={focusUid}
              disabled={locked}
              onChange={(event) => setFocusUid(Number(event.target.value))}
            >
              <option value={0}>全部（含历史学生）</option>
              {[...new Set([...data.roster, ...data.items.map((event) => event.studentUid)])].map((uid: number) => (
                <option key={uid} value={uid}>
                  {userText(uid)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <button type="button" className="button compact" onClick={() => load()}>
          刷新
        </button>
      </div>
      <p className="supplementary cf-instructions">
        选一次课时和题目，逐人点一下即保存。备注、细项可空。提交与成绩共享“本课程该题”的结果。
      </p>
      {store.hasUnsaved() && !store.pending ? <p className="supplementary">未保存内容已在本页保留；切回原学生和题目可继续编辑。</p> : null}
      <div className={`cf-notice cf-notice--${store.tone}`} role="status" aria-live="polite">
        {store.notice || '只记录实际发生的指导、核对或复测需要。'}
        {store.undo && store.tone === 'success' ? (
          <button type="button" className="button compact" disabled={locked} onClick={undo}>
            {store.undo.action === 'retract' ? '撤销这次观察' : '撤销这次处理'}
          </button>
        ) : null}
        {store.pending ? (
          <button
            type="button"
            className="button primary compact"
            disabled={store.busy || identityChanged}
            onClick={() => store.send(store.pending!)}
          >
            重试本次操作
          </button>
        ) : null}
      </div>
      {identityChanged ? <p role="alert">当前账号与原操作教师不同，请恢复原账号后核实。</p> : null}
      {loadError ? (
        <p className="cf-error" role="alert">
          {loadError} {store.tone === 'success' ? '已确认保存的操作不会重复提交。' : ''}
        </p>
      ) : null}
      {!data ? (
        <p>{loadError ? '暂无查询结果。' : '正在加载…'}</p>
      ) : view === 'roster' ? (
        <div className="cf-table-wrap">
          <table className="data-table cf-roster">
            <thead>
              <tr>
                <th>学生</th>
                <th>本课程该题</th>
                <th>本课时最近观察</th>
                <th>快捷记录</th>
              </tr>
            </thead>
            <tbody>
              {roster.map((uid) => {
                const latest =
                  ready && pid && (nodeId !== '' || data.activity.activityType !== 'course')
                    ? data.items.find((event) => event.studentUid === uid)
                    : null;
                const current = data.latest[`${uid}:${pid}`];
                const draft = store.draft(key(uid));
                return (
                  <React.Fragment key={uid}>
                    <tr data-feedback-student={uid}>
                      <td>
                        <strong>{userText(uid)}</strong>
                        <br />
                        <span className="supplementary">UID {uid}</span>
                      </td>
                      <td>{pid ? current ? <a href={current.url}>{current.score} 分 · 最近提交</a> : '暂无可见提交' : '请选择题目'}</td>
                      <td>
                        {latest ? (
                          <span>
                            {kinds[latest.kind]} · {states[latest.state]}
                            <br />
                            <span className="supplementary">{new Date(latest.recordedAt).toLocaleString()}</span>
                          </span>
                        ) : pid ? (
                          '暂无有效观察'
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="cf-quick-actions">
                        {Object.entries(kinds).map(([kind, label]) => (
                          <button
                            type="button"
                            key={kind}
                            className={`button compact${kind === 'NEEDS_RETEST' ? ' cf-retest' : ''}`}
                            disabled={locked || !ready || !pid || (data.activity.activityType === 'course' && nodeId === '')}
                            onClick={() => observe(uid, kind)}
                          >
                            {label}
                          </button>
                        ))}
                        <button
                          type="button"
                          className="button compact"
                          disabled={locked}
                          aria-expanded={expanded === uid}
                          onClick={() => setExpanded(expanded === uid ? 0 : uid)}
                        >
                          {expanded === uid ? '收起' : draft.note || draft.detail ? '继续编辑' : '细项 / 备注'}
                        </button>
                      </td>
                    </tr>
                    {expanded === uid ? (
                      <tr className="cf-editor-row">
                        <td colSpan={4}>
                          <div className="cf-editor">
                            <label>
                              备注（可空，最多 500 字）
                              <textarea
                                className="textbox"
                                rows={2}
                                value={draft.note}
                                disabled={locked}
                                onChange={(event) => store.edit(key(uid), { ...draft, note: event.target.value })}
                              />
                            </label>
                            <label>
                              细项（可空）
                              <select
                                className="select"
                                value={draft.detail}
                                disabled={locked}
                                onChange={(event) => store.edit(key(uid), { ...draft, detail: event.target.value })}
                              >
                                <option value="">不填写</option>
                                {Object.entries(details).map(([kind, values]) => (
                                  <optgroup key={kind} label={kinds[kind]}>
                                    {Object.entries(values).map(([value, label]) => (
                                      <option key={value} value={`${kind}:${value}`}>
                                        {label}
                                      </option>
                                    ))}
                                  </optgroup>
                                ))}
                              </select>
                            </label>
                            <span className="supplementary">填写后点对应动作保存。</span>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </React.Fragment>
                );
              })}
              {!roster.length ? (
                <tr>
                  <td colSpan={4}>当前没有匹配的学生。</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          {view === 'pending' ? (
            <p>
              本课程待复测共 <strong>{data.totalPending}</strong> 条；当前筛选 <strong>{data.filteredTotal}</strong> 条。
            </p>
          ) : null}
          <div className="cf-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>学生 / 原观察</th>
                  <th>上下文与备注</th>
                  <th>当前状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((event) => (
                  <tr key={event._id}>
                    <td>
                      <strong>{userText(event.studentUid)}</strong>
                      {!data.roster.includes(event.studentUid) ? <small>（已离开当前名单）</small> : null}
                      <br />
                      {kinds[event.kind]}
                      <br />
                      <span className="supplementary">
                        {userText(event.operatorUid)} · {new Date(event.recordedAt).toLocaleString()}
                      </span>
                    </td>
                    <td>
                      {contextText(event)}
                      <br />
                      {event.detail ? `${details[event.kind]?.[event.detail] || event.detail} · ` : ''}
                      {event.note || '无备注'}
                    </td>
                    <td>{states[event.state]}</td>
                    <td>{renderActions(event)}</td>
                  </tr>
                ))}
                {!data.items.length ? (
                  <tr>
                    <td colSpan={4}>{view === 'pending' ? '当前筛选没有待复测记录。' : '当前筛选没有观察记录。'}</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          {data.next ? (
            <button type="button" className="button" disabled={locked} onClick={() => load(data.next)}>
              更多记录
            </button>
          ) : null}
        </>
      )}
      {detailEvent ? (
        <section className="cf-detail section" aria-label="观察详情">
          <div className="section__header">
            <h2 className="section__title">观察详情 · {userText(detailEvent.studentUid)}</h2>
          </div>
          <div className="section__body">
            <p>
              {detailEvent.context?.courseTitle || '录入时课程名称未核实'} · {contextText(detailEvent)}
            </p>
            <p>
              {kinds[detailEvent.kind]} · {detailEvent.note || '无备注'} · {states[detailEvent.state]}
            </p>
            <p>{submission(detailEvent.rid, '记录时提交')}</p>
            <p>{submission(detailEvent.resolution?.rid, '跟进时提交')}</p>
            <p>
              本课程该题当前提交：
              {data?.latest[`${detailEvent.studentUid}:${detailEvent.pid}`] ? (
                <a href={data.latest[`${detailEvent.studentUid}:${detailEvent.pid}`].url}>查看最近提交</a>
              ) : (
                '暂无可见提交'
              )}
            </p>
            <ul>
              {detailEvent.changes.map((entry) => (
                <li key={entry._id}>
                  {
                    { OBSERVATION_RETRACTED: '撤销原观察', RETEST_RESOLVED: '完成跟进', RETEST_RESOLUTION_RETRACTED: '撤销处理' }[
                      entry.eventType
                    ]
                  }
                  {' · '}
                  {userText(entry.operatorUid)} · {new Date(entry.recordedAt).toLocaleString()} · {entry.note || '无备注'}
                </li>
              ))}
            </ul>
            {renderActions(detailEvent)}
            {detailEvent.state !== 'retracted' && (data.manager || detailEvent.operatorUid === data.operatorUid) ? (
              <button type="button" className="button compact" disabled={locked} onClick={() => change(detailEvent, 'retract')}>
                撤销原观察
              </button>
            ) : null}
            <button type="button" className="button compact" onClick={() => setDetailEvent(null)}>
              关闭详情
            </button>
          </div>
        </section>
      ) : null}
      <p className="supplementary cf-footer">“核对过”表示进行过核对；“完成跟进”不自动表示复测通过。观察保存在 Hydro。</p>
    </div>
  );
}
