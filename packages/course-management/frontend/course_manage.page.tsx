import {
  addPage, NamedPage, Notification, React, ReactDOM,
} from '@hydrooj/ui-default';

type CourseManagePayload = {
  page_name?: string;
  tdoc: any;
  tsdict: Record<string, any>;
  udict: Record<string, any>;
  group: { students: number[] };
  extraStudents: number[];
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
  const [tab, setTab] = React.useState<'students' | 'extraStudents' | 'chapters'>('students');

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
        if (!dag.length) {
          Notification.error('课程暂无章节');
        }
      }
    } catch (e: any) {
      Notification.error(e?.message || '加载失败');
      setPayload(null);
    } finally {
      setLoading(false);
    }
  }, []);

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

  const { tdoc, tsdict, udict, group, extraStudents } = payload;
  const students = sortStudents(group?.students || [], udict);
  const extraStudentList = sortStudents(extraStudents || [], udict);
  const dag: any[] = tdoc?.dag || [];
  const studentUids = group?.students || [];
  const basePath = window.location.pathname.replace(/\/manage$/, '');

  const renderTabs = () => (
    <div className="row">
      <div className="columns">
        <div className="course-manage-tabs">
          <span
            className={`course-manage-tab ${tab === 'students' ? 'active' : ''}`}
            onClick={() => setTab('students')}
          >
            班级成员管理
          </span>
          <span
            className={`course-manage-tab ${tab === 'extraStudents' ? 'active' : ''}`}
            onClick={() => setTab('extraStudents')}
          >
            临时调课学生 ({extraStudents?.length || 0})
          </span>
          <span
            className={`course-manage-tab ${tab === 'chapters' ? 'active' : ''}`}
            onClick={() => setTab('chapters')}
          >
            课程节点管理
          </span>
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
          <table className="data-table course-manage-table">
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

  const renderExtraStudentsTab = () => (
    <div>
      <div className="row">
        <div className="columns">
          <div className="button-group">
            <a
              href={`${basePath}/edit`}
              className="rounded primary button"
            >
              编辑临时学生名单
            </a>
          </div>
        </div>
      </div>
      {extraStudentList.length === 0 ? (
        <div className="row">
          <div className="columns">
            <p className="typo">暂无临时调课学生。</p>
          </div>
        </div>
      ) : (
        <div className="row">
          <div className="columns">
            <table className="data-table course-manage-table">
              <thead>
                <tr>
                  <th style={{ width: 100 }}>UID</th>
                  <th>用户</th>
                  <th style={{ width: 200 }}>课程访问</th>
                </tr>
              </thead>
              <tbody>
                {extraStudentList.map((uid) => {
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
      )}
    </div>
  );

  const renderNodeTab = () => (
    <div>
      <div className="row">
        <div className="columns">
          <table className="data-table course-manage-table">
            <thead>
              <tr>
                <th style={{ width: 80 }}>节点</th>
                <th>章节标题</th>
                <th style={{ width: 180 }}>讲义</th>
                <th style={{ width: 220 }}>题目</th>
                <th style={{ width: 140 }}>题目</th>
              </tr>
            </thead>
            <tbody>
              {dag.map((node) => {
                const nodeId = +node._id;
                const hasLecture = !!(node?.lecture || tdoc?.lecture?.[nodeId]);
                const canBulk = studentUids.length > 0;
                const lectureAllowed = canBulk && studentUids.every((uid) => !!tsdict?.[uid]?.lectureAllow?.[nodeId]);
                const nodeAllowed = canBulk && studentUids.every((uid) => !!tsdict?.[uid]?.allow?.[nodeId]);
                const lectureEditUrl = `${basePath}/lecture/${nodeId}?edit=1`;
                return (
                  <tr key={nodeId}>
                    <td>{nodeId}</td>
                    <td>{node?.title || '-'}</td>
                    <td>
                      {hasLecture ? (
                        <span>
                          有
                          {' '}
                          <a href={lectureEditUrl}>编辑</a>
                          {' | '}
                          <a
                            href="#"
                            onClick={(e) => {
                              e.preventDefault();
                              if (!canBulk) return;
                              post({ operation: 'allowLecture', uid: 0, node: nodeId, allow: !lectureAllowed });
                            }}
                          >
                            {lectureAllowed ? '关闭' : '开放给学员'}
                          </a>
                        </span>
                      ) : (
                        '无'
                      )}
                    </td>
                    <td>{(node?.pids || []).join(',')}</td>
                    <td>
                      <a
                        href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          if (!canBulk) return;
                          post({ operation: 'allowUser', uid: 0, node: nodeId, allow: !nodeAllowed });
                        }}
                      >
                        {nodeAllowed ? '关闭' : '开放给学员'}
                      </a>
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

  return (
    <div>
      <div className="row">
        <div className="columns typo">
          <h2 className="course-manage-title" style={{ marginTop: 0 }}>{tdoc?.title || '课程管理'}</h2>
        </div>
      </div>
      {renderTabs()}
      {tab === 'students' ? renderStudentsTab() : null}
      {tab === 'extraStudents' ? renderExtraStudentsTab() : null}
      {tab === 'chapters' ? renderNodeTab() : null}
    </div>
  );
}

addPage(new NamedPage('course_manage', () => {
  const container = document.getElementById('course');
  if (!container) return;
  ReactDOM.createRoot(container).render(<CourseManageApp />);
}));
