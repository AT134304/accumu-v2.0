// Accumu v2 — 관리자 홈 (docs/specs/qr-dual-auth.md "D. 관리자 — 홈", CLAUDE.md 10장 "오늘 진행 프로그램 우선")
//
// 기존 63줄 골격(이름 + 로그아웃)을 전면 교체한다. 로그아웃은 사라진 게 아니라 관리자 셸 우측으로 옮겼다.
//
// [읽기 전용 화면이다] 이번 1단계에서 관리자가 여기서 할 수 있는 유일한 행동은 "QR 스캔으로 이동"이다.
//   프로그램 올리기/내리기/수정은 2단계(별도 화면). 여기에 등록/수정 버튼을 앞당겨 만들지 않는다.
//
// [원칙 1·6 가드 — 표시하지 않는 것]
//   참여자 수 / 신청자 명단 / 출석률 / 학생 랭킹 / 학교 단위 통계. UI 규율이 아니라 RLS 구조로도 성립한다
//   (관리자는 담당 학생 5명의 completed 참여 외에는 participations 를 아예 읽을 수 없다 — ADR 0005 결정 7-2(d)).
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import Icon from '../components/Icon';
import { catOf } from '../lib/taxonomy';
import { fmtDate } from '../lib/date';
import { fetchAdminHomePrograms } from '../lib/programService';
import '../styles/AdminShell.css';

export default function AdminHomePage() {
  const { profile } = useAuth();
  const navigate = useNavigate();

  const [today, setToday] = useState([]);
  const [upcoming, setUpcoming] = useState([]);
  const [state, setState] = useState('loading'); // 'loading' | 'ready' | 'error'

  useEffect(() => {
    let cancelled = false;
    const adminId = profile?.id;
    if (!adminId) return undefined;

    (async () => {
      setState('loading');
      try {
        const res = await fetchAdminHomePrograms(adminId);
        if (cancelled) return;
        setToday(res.today);
        setUpcoming(res.upcoming);
        setState('ready');
      } catch (err) {
        if (cancelled) return;
        // 마이그레이션 미적용/네트워크 오류에도 셸과 스캔 진입 경로는 살아 있어야 한다.
        console.error('[AdminHome] 프로그램 조회 실패:', err);
        setToday([]);
        setUpcoming([]);
        setState('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [profile?.id]);

  return (
    <section className="screen">
      <div className="sec-head">
        <div>
          <div className="eyebrow">Admin</div>
          <h2 className="sec">오늘 진행 프로그램</h2>
          <div className="sec-sub">
            {profile?.name} 님이 올린 프로그램 중 오늘 진행되는 활동입니다
          </div>
        </div>
        <button type="button" className="adm-scanall" onClick={() => navigate('/admin/scan')}>
          <Icon name="ic-qr" size={17} />
          QR 스캔 열기
        </button>
      </div>

      {state === 'loading' && <div className="empty">프로그램을 불러오는 중…</div>}

      {state === 'error' && (
        <div className="empty">
          프로그램을 불러오지 못했어요.
          <br />
          잠시 후 다시 시도해 주세요.
        </div>
      )}

      {state === 'ready' &&
        (today.length === 0 ? (
          <div className="empty">오늘 진행되는 프로그램이 없습니다.</div>
        ) : (
          <div className="adm-list">
            {today.map((p) => (
              <ProgramRow
                key={p.id}
                program={p}
                action={
                  <button
                    type="button"
                    className="adm-scan"
                    onClick={() => navigate(`/admin/scan?program=${p.id}`)}
                  >
                    <Icon name="ic-qr" size={16} />
                    QR 스캔
                  </button>
                }
              />
            ))}
          </div>
        ))}

      {state === 'ready' && upcoming.length > 0 && (
        <>
          <div className="sec-head" style={{ marginTop: 34 }}>
            <div>
              <h2 className="sec sm">예정된 프로그램</h2>
              <div className="sec-sub">가까운 순서로 최대 5건까지 보여줍니다</div>
            </div>
          </div>
          <div className="adm-list muted">
            {upcoming.map((p) => (
              <ProgramRow key={p.id} program={p} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/** 프로그램 1줄 — 카테고리 아이콘 + 제목 + 일시/포인트. 참여자 관련 숫자는 어떤 것도 넣지 않는다. */
function ProgramRow({ program, action = null }) {
  const cat = catOf(program.category);
  return (
    <div className="adm-row">
      <div className="ic" style={{ background: cat.soft }}>
        <Icon name={cat.icon} size={20} color={cat.color} />
      </div>
      <div className="info">
        <h5>{program.title}</h5>
        <div className="m">
          {[cat.group && `${cat.group} · ${cat.name}`, program.org, fmtDate(program.date), program.time]
            .filter(Boolean)
            .join(' · ')}
        </div>
      </div>
      {/* 포인트는 amber 한 곳에만, 작게 (원칙 4) */}
      {program.points != null && <div className="pt">{program.points.toLocaleString()}P</div>}
      {action}
    </div>
  );
}
