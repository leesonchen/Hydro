import {
  addPage, NamedPage, Notification, React, ReactDOM,
} from '@hydrooj/ui-default';

type CourseManagePayload = {
  page_name?: string;
  tdoc: any;
  tsdict: Record<string, any>;
  udict: Record<string, any>;
  group: { students: number[] };
  error?: { message: string };
};

async function requestJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: 'same-origin',
    ...init,
    headers: {
      accept: 'application/json',
      ...(init?.headers || {}),
    },
  });
  return await res.json();
}

function getUserText(udoc: any) {
  if (!udoc) return '';
  const uname = udoc.uname || '';
  const displayName = udoc.displayName || '';
  if (displayName && displayName !== uname) return `${uname} (${displayName})`;
  return uname || displayName;
}

function sortStudents(uids: number[], udict: Record<string, any>) {
  return [...uids].sort((a, b) => {
    const ua = getUserText(udict[a]);
    const ub = getUserText(udict[b]);
    return ua.localeCompare(ub, 'zh-Hans-CN');
  });
}

function CourseManageApp() {
  const [loading, setLoading] = React.useState(true);
  const [payload, setPayload] = React.useState<CourseManagePayload | null>(null);
  const [tab, setTab] = React.useState<'students' | 'chapters' | 'lectures'>('students');
  const [selectedNode, setSelectedNode] = React.useState<number | null>(null);
  const [selectedLectureNode, setSelectedLectureNode] = React.useState<number | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const data = await requestJSON<CourseManagePayload>('', {
        headers: {
          'Content-Type': 'application/json',
        },
      });
      if (data?.error) {
        Notification.error(data.error.message);
        setPayload(null);
      } else {
        setPayload(data);
        const dag: any[] = data?.tdoc?.dag || [];
        if (!selectedNode && dag.length) setSelectedNode(+dag[0]._id);
        const lectureNodes = dag.filter((n) => n?.lecture || data?.tdoc?.lecture?.[n._id]);
        if (!selectedLectureNode && lectureNodes.length) setSelectedLectureNode(+lectureNodes[0]._id);
      }
    } catch (e: any) {
      Notification.error(e?.message || '加载失败');
      setPayload(null);
    } finally {
      setLoading(false);
    }
  }, [selectedNode, selectedLectureNode]);

  React.useEffect(() => {
    load();
  }, [load]);

  const post = React.useCallback(async (body: Record<string, any>) => {
    try {
      const data = await requestJSON<any>('', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (data?.error) {
        Notification.error(data.error.message);
        return false;
      }
      await load();
      Notification.success('操作成功');
      return true;
    } catch (e: any) {
      Notification.error(e?.message || '操作失败');
      return false;
    }
  }, [load]);

  if (loading) {
    return (
      <div className="typo">
        <p>Loading...</p>
      </div>
    );
  }

  if (!payload) {
    return (
      <div className="typo">
        <p>无法加载课程管理信息。</p>
      </div>
    );
  }

  const { tdoc, tsdict, udict, group } = payload;
  const students = sortStudents(group?.students || [], udict);
  const dag: any[] = tdoc?.dag || [];
  const lectureNodes = dag.filter((n) => n?.lecture || tdoc?.lecture?.[n._id]);

  const renderTabs = () => (
    <div className="row">
      <div className="columns">
        <div className="button-group">
          <button type="button" className={`rounded button ${tab === 'students' ? 'primary' : ''}`} onClick={() => setTab('students')}>
            学生
          </button>
          <button type="button" className={`rounded button ${tab === 'chapters' ? 'primary' : ''}`} onClick={() => setTab('chapters')}>
            章节
          </button>
          <button type="button" className={`rounded button ${tab === 'lectures' ? 'primary' : ''}`} onClick={() => setTab('lectures')}>
            讲义
          </button>
        </div>
      </div>
    </div>
  );

  const renderStudentsTab = () => (
    <div>
      <div className="row">
        <div className="columns">
          <div className="button-group">
            <button type="button" className="rounded primary button" onClick={() => post({ operation: 'visit', uid: 0, allow: true })}>
              批量允许访问
            </button>
            <button type="button" className="rounded button" onClick={() => post({ operation: 'visit', uid: 0, allow: false })}>
              批量禁止访问
            </button>
          </div>
        </div>
      </div>
      <div className="row">
        <div className="columns">
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: 100 }}>UID</th>
                <th>用户</th>
                <th style={{ width: 200 }}>课程访问</th>
              </tr>
            </thead>
            <tbody>
              {students.map((uid) => {
                const tsdoc = tsdict?.[uid];
                const allowed = !!tsdoc;
                return (
                  <tr key={uid}>
                    <td>{uid}</td>
                    <td>{getUserText(udict?.[uid])}</td>
                    <td>
                      {allowed ? (
                        <button
                          type="button"
                          className="rounded button"
                          onClick={() => post({ operation: 'visit', uid, allow: false })}
                        >
                          禁止访问
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="rounded primary button"
                          onClick={() => post({ operation: 'visit', uid, allow: true })}
                        >
                          允许访问
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );

  const renderNodeTab = (mode: 'allow' | 'lectureAllow') => {
    const isLecture = mode === 'lectureAllow';
    const nodes = isLecture ? lectureNodes : dag;
    const currentNode = isLecture ? selectedLectureNode : selectedNode;

    return (
      <div>
        <div className="row">
          <div className="columns">
            <label>
              选择{isLecture ? '讲义' : '章节'}
              <div className="textbox-container">
                <select
                  className="select"
                  value={currentNode ?? ''}
                  onChange={(e) => {
                    const v = +e.target.value;
                    if (Number.isFinite(v)) {
                      if (isLecture) setSelectedLectureNode(v);
                      else setSelectedNode(v);
                    }
                  }}
                >
                  {nodes.map((n) => (
                    <option key={n._id} value={n._id}>{n.title}</option>
                  ))}
                </select>
              </div>
            </label>
          </div>
        </div>

        <div className="row">
          <div className="columns">
            <div className="button-group">
              <button
                type="button"
                className="rounded primary button"
                disabled={currentNode == null}
                onClick={() => post({ operation: isLecture ? 'allowLecture' : 'allowUser', uid: 0, node: currentNode, allow: true })}
              >
                批量开放
              </button>
              <button
                type="button"
                className="rounded button"
                disabled={currentNode == null}
                onClick={() => post({ operation: isLecture ? 'allowLecture' : 'allowUser', uid: 0, node: currentNode, allow: false })}
              >
                批量关闭
              </button>
            </div>
          </div>
        </div>

        <div className="row">
          <div className="columns">
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 100 }}>UID</th>
                  <th>用户</th>
                  <th style={{ width: 200 }}>{isLecture ? '讲义' : '章节'}权限</th>
                </tr>
              </thead>
              <tbody>
                {students.map((uid) => {
                  const tsdoc = tsdict?.[uid];
                  const attended = !!tsdoc;
                  const allowed = !!(tsdoc?.[mode]?.[currentNode as any]);
                  const op = isLecture ? 'allowLecture' : 'allowUser';
                  return (
                    <tr key={uid}>
                      <td>{uid}</td>
                      <td>{getUserText(udict?.[uid])}</td>
                      <td>
                        {attended ? (
                          allowed ? (
                            <button
                              type="button"
                              className="rounded button"
                              disabled={currentNode == null}
                              onClick={() => post({ operation: op, uid, node: currentNode, allow: false })}
                            >
                              关闭
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="rounded primary button"
                              disabled={currentNode == null}
                              onClick={() => post({ operation: op, uid, node: currentNode, allow: true })}
                            >
                              开放
                            </button>
                          )
                        ) : (
                          <span className="typo">未加入课程</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div>
      <div className="row">
        <div className="columns typo">
          <h2 style={{ marginTop: 0 }}>{tdoc?.title || '课程管理'}</h2>
        </div>
      </div>
      {renderTabs()}
      {tab === 'students' ? renderStudentsTab() : null}
      {tab === 'chapters' ? renderNodeTab('allow') : null}
      {tab === 'lectures' ? (
        lectureNodes.length
          ? renderNodeTab('lectureAllow')
          : (
            <div className="row"><div className="columns typo"><p>该课程暂无讲义。</p></div></div>
          )
      ) : null}
    </div>
  );
}

addPage(new NamedPage('course_manage', () => {
  const container = document.getElementById('course');
  if (!container) return;
  ReactDOM.createRoot(container).render(<CourseManageApp />);
}));
