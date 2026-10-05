import React from 'react';
import { v4 as uuid } from 'uuid';

const kinds = { GUIDED: '指导过', CHECKED: '核对过', NEEDS_RETEST: '需复测' };
const details = {
  GUIDED: { IDEA: '思路', DEBUGGING: '调试' },
  CHECKED: { REASONING: '关键思路', BOUNDARY: '边界', CODE_EXPLANATION: '代码解释' },
  NEEDS_RETEST: { UNDERSTANDING: '题意理解', BOUNDARY: '边界', TRANSFER: '迁移' },
};

async function read(url: string) {
  const response = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
  if (!response.ok || response.redirected) throw new Error('反馈查询失败，请确认登录和授课权限后刷新。');
  const data = await response.json();
  if (data.error || !Array.isArray(data.items)) throw new Error('反馈查询失败，请刷新重试。');
  return data;
}

export default function ClassroomFeedback({ url }: { url: string }) {
  const [data, setData] = React.useState<any>(null);
  const [studentUid, setStudent] = React.useState('');
  const [problem, setProblem] = React.useState('');
  const [note, setNote] = React.useState('');
  const [kind, setKind] = React.useState('GUIDED');
  const [detail, setDetail] = React.useState('');
  const [rid, setRid] = React.useState('');
  const [pendingOnly, setPendingOnly] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const [pending, setPending] = React.useState<{ url: string, body: any } | null>(null);
  const inFlight = React.useRef(false);
  const prefilled = React.useRef(false);

  const load = React.useCallback(async (before = '') => {
    const query = new URLSearchParams({ pending: String(pendingOnly) });
    if (before) query.set('before', before);
    const payload = await read(`${url}?${query}`);
    setData((previous) => ({ ...payload, items: before ? [...previous.items, ...payload.items] : payload.items }));
    return payload;
  }, [url, pendingOnly]);

  React.useEffect(() => {
    let active = true;
    read(`${url}?pending=${pendingOnly}`).then((payload) => {
      if (!active) return;
      setData(payload);
      if (prefilled.current) return;
      prefilled.current = true;
      const params = new URLSearchParams(window.location.search);
      const uid = params.get('studentUid') || '';
      if (payload.roster.includes(Number(uid))) setStudent(uid);
      const pid = Number(params.get('pid'));
      const nodes = payload.activity.nodes.filter((n) => n.pids.includes(pid));
      if (payload.activity.pids.includes(pid) && nodes.length <= 1) {
        setProblem(`${pid}:${nodes[0]?._id ?? ''}`);
      }
      // Ambiguous course nodes remain unselected; the teacher selects context.
      const submission = params.get('rid');
      if (submission && /^[a-f0-9]{24}$/.test(submission)) setRid(submission);
    }).catch((error) => { if (active) setMessage(error.message); });
    return () => { active = false; };
  }, [url, pendingOnly]);

  const send = async (operation: { url: string, body: any }) => {
    if (inFlight.current) return;
    const retrying = !!pending;
    inFlight.current = true;
    setPending(operation);
    setBusy(true);
    setMessage('正在保存…');
    try {
      const response = await fetch(operation.url, {
        method: 'POST', credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(operation.body),
      });
      const receipt = await response.json();
      if ([400, 403, 409].includes(response.status)) {
        if (!retrying) setPending(null);
        setMessage(retrying
          ? '保存状态仍待确认，本次重试被拒绝。请确认登录、授课权限或稍后用原操作重试。'
          : receipt.error?.message || '操作被拒绝，请检查输入及授课权限后重试。');
        return;
      }
      if (!response.ok || response.redirected || !receipt.eventId || !receipt.recordedAt) throw new Error('Unconfirmed');
      setPending(null);
      setMessage('已保存到 Hydro。');
      if (operation.url === url) {
        setNote('');
        setDetail('');
      }
      // A failed refresh must never turn a confirmed save into a new request.
      try {
        await load();
      } catch {
        setMessage('已保存到 Hydro；列表刷新失败，请刷新查询。');
      }
    } catch {
      setMessage('保存状态待确认。表单已保留，请用“重试本次操作”核实；登录过期时请先重新登录。');
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  };

  const observe = (selectedKind: string) => {
    if (!data || !studentUid || !problem || pending || busy) return;
    if ([...note].length > 500) {
      setMessage('备注最多 500 字，请缩短后保存。');
      return;
    }
    const [pid, nodeId] = problem.split(':');
    const body = {
      requestId: uuid(), activityType: data.activity.activityType, activityId: data.activity.activityId,
      studentUid: Number(studentUid), pid: Number(pid), kind: selectedKind, note,
      ...(nodeId !== '' ? { nodeId: Number(nodeId) } : {}), ...(rid ? { rid } : {}),
      ...(detail && selectedKind === kind ? { detail } : {}),
    };
    send({ url, body });
  };

  const change = (event, action: string) => {
    if (pending || busy) return;
    if ([...note].length > 500) {
      setMessage('备注最多 500 字，请缩短后保存。');
      return;
    }
    // eslint-disable-next-line no-alert
    if (action === 'retract' && !window.confirm('撤销这条观察？原记录仍会保留。')) return;
    send({ url: `${url}/${event._id}/${action}`, body: { requestId: uuid(), note, ...(rid ? { rid } : {}) } });
  };

  const userText = (uid) => data?.udict[uid]?.displayName || data?.udict[uid]?.uname || `UID ${uid}`;
  const options = data?.activity.nodes.length
    ? data.activity.nodes.flatMap((node) => node.pids.map((pid) => ({ pid, nodeId: node._id, title: node.title })))
    : data?.activity.pids.map((pid) => ({ pid, nodeId: '', title: '' })) || [];
  const locked = busy || !!pending;
  return (
    <div className="typo" data-classroom-feedback>
      <h2>课堂反馈</h2>
      <p>记录保存在 Hydro。“核对过”表示进行过核对；“已处理”表示完成跟进，均不自动代表掌握或通过认证。</p>
      <p role="status" aria-live="polite">{message}</p>
      {pending ? <button className="button primary" disabled={busy} onClick={() => send(pending)}>重试本次操作</button> : null}
      {!data ? <button className="button" onClick={() => load().catch((error) => setMessage(error.message))}>重新查询</button> : (
        <>
          <fieldset disabled={locked}>
            <label>学生（无需提交）<select value={studentUid} onChange={(e) => { setStudent(e.target.value); setRid(''); }}>
              <option value="">请选择学生</option>
              {data.roster.map((uid) => <option key={uid} value={uid}>{userText(uid)}</option>)}
            </select></label>
            <label>题目 / 课时<select value={problem} onChange={(e) => { setProblem(e.target.value); setRid(''); }}>
              <option value="">请选择题目和课时</option>
              {options.map((o) => <option key={`${o.pid}:${o.nodeId}`} value={`${o.pid}:${o.nodeId}`}>
                {o.title ? `${o.title} · ` : ''}P{o.pid} {data.pdict[o.pid]?.title}
              </option>)}
            </select></label>
            <details><summary>可选细项、备注和提交编号</summary>
              <label>动作<select value={kind} onChange={(e) => { setKind(e.target.value); setDetail(''); }}>
                {Object.entries(kinds).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
              </select></label>
              <label>细项<select value={detail} onChange={(e) => setDetail(e.target.value)}><option value="">不填写</option>
                {Object.entries(details[kind]).map(([value, text]) => <option key={value} value={value}>{text as string}</option>)}
              </select></label>
              <label>备注（最多 500 字）<textarea value={note} onChange={(e) => setNote(e.target.value)} /></label>
              <label>提交编号（可空）<input value={rid} onChange={(e) => setRid(e.target.value.trim())} /></label>
            </details>
            <div className="button-group">{Object.entries(kinds).map(([value, text]) => (
              <button key={value} className="button" disabled={!studentUid || !problem} onClick={() => observe(value)}>{text}</button>
            ))}</div>
          </fieldset>
          <p><label><input type="checkbox" checked={pendingOnly} disabled={busy} onChange={(e) => setPendingOnly(e.target.checked)} />只看待复测</label>
            <button className="button" disabled={busy} onClick={() => load().catch((error) => setMessage(error.message))}>刷新列表</button></p>
          <table><thead><tr><th>学生 / 题目</th><th>观察</th><th>教师 / 时间</th><th>处理</th></tr></thead>
            <tbody>{data.items.map((event) => <tr key={event._id}>
              <td>{userText(event.studentUid)}<br />P{event.pid} {data.pdict[event.pid]?.title}
                {event.nodeId !== undefined
                  ? ` · ${data.activity.nodes.find((n) => n._id === event.nodeId)?.title || `历史课时 ${event.nodeId}`}` : ''}</td>
              <td>{kinds[event.kind]}{event.detail ? ` · ${details[event.kind][event.detail]}` : ''}<br />{event.note}
                {event.changes.map((c) => <p key={c._id}>
                  {c.eventType === 'OBSERVATION_RETRACTED' ? '已撤销' : '已处理'} · {userText(c.operatorUid)} ·
                  {new Date(c.recordedAt).toLocaleString()} {c.note}
                </p>)}</td>
              <td>{userText(event.operatorUid)}<br />{new Date(event.recordedAt).toLocaleString()}</td>
              <td>{!event.retracted && (data.manager || event.operatorUid === data.operatorUid)
                ? <button disabled={locked} className="button" onClick={() => change(event, 'retract')}>撤销</button> : null}
              {event.kind === 'NEEDS_RETEST' && !event.retracted && !event.resolved
                ? <button disabled={locked} className="button" onClick={() => change(event, 'resolve')}>已处理</button> : null}</td>
            </tr>)}</tbody>
          </table>
          {!data.items.length ? <p>暂无记录。</p> : null}
          {data.next ? (
            <button
              className="button"
              disabled={busy}
              onClick={() => load(data.next).catch((error) => setMessage(error.message))}
            >更多记录</button>
          ) : null}
        </>
      )}
    </div>
  );
}
