// Accumu v2 — 담당 학생 아카이브 상세 (docs/specs/admin-students.md B절 / 결정 A·C·D·F·G·H·J)
//
// [한 화면에 학생이 1명만 존재한다 — 결정 A]
//   목록에서 들어오는 순간 계정 정보와 나머지 4명이 화면에서 사라진다. 비교 UI를 만들려야 만들 수 없고,
//   인쇄 대상도 "지금 이 페이지"로 자명해진다. 마스터-디테일 2단 레이아웃을 쓰지 않는 이유가 이것이다.
//
// [포인트 — ADR 0015 로 개정] 원래 이 화면은 포인트를 아예 조회하지 않았다("얼마 벌었나"가 아니라
//   "무슨 활동을 했는가"라는 원칙 4). 케빈 요청으로 학생 1명 헤더에 한해 열었다 — points_balance/
//   points_total 만 짧은 한 줄로. 활동 행 단위 지급액(amountByParticipationId)은 여전히 넘기지 않는다 —
//   그건 "이 활동으로 얼마 벌었나"라 활동 목록을 포인트 나열로 바꾼다. 목록 화면(AdminMyPage, 5명 나란히)
//   에는 여전히 숫자를 안 보여준다(결정 B는 그대로 유효) — 이 화면(1명)에서만 예외다.
//
// [별점·한줄평도 없다 — student-archive-mypage 결정 E]
//   reviews_select_own 이 "본인 참여의 리뷰"만 열어 관리자는 담당 학생 것도 읽을 수 없다.
//   그래서 reviewByParticipationId 도 넘기지 않는다(넘길 데이터를 얻을 수도 없다).
//
// [쓰기 동작 — ADR 0015 로 1개 생겼다] participations 에는 여전히 관리자 update 정책이 0개라
//   코멘트·확인 도장·활동 추가는 없다. 딱 하나 생긴 것은 "담당 해제"(mentor_students 삭제) — 관리자
//   기능이 3종에서 4종이 됐다(CLAUDE.md 원칙 6 개정).
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import Modal from '../components/Modal';
import Icon from '../components/Icon';
import ArchiveHero from '../components/archive/ArchiveHero';
import ArchiveSummary from '../components/archive/ArchiveSummary';
import ArchivePrintHeader from '../components/archive/ArchivePrintHeader';
import ActivityList from '../components/archive/ActivityList';
import { TRACK } from '../lib/taxonomy';
import { fetchCompletedActivitiesOf, fetchMentoredStudent, removeMentee } from '../lib/archiveService';
import { todayISO } from '../lib/date';
import '../styles/AdminShell.css';

const PRINT_TITLE = 'Accumu 활동 아카이브';

export default function AdminStudentArchivePage() {
  const { studentId } = useParams();
  const navigate = useNavigate();

  const [student, setStudent] = useState(null);
  // 'loading' | 'ready' | 'notfound' | 'error' — notfound(담당 아님)를 error 로 뭉개지 않는다.
  const [headerState, setHeaderState] = useState('loading');
  const [activities, setActivities] = useState([]);
  const [listState, setListState] = useState('loading'); // 'loading' | 'ready' | 'error'

  // 담당 해제 확인 (ADR 0015) — AdminProgramsPage의 "내리기 확인" 과 같은 2단계 패턴.
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState('');

  useEffect(() => {
    let cancelled = false;

    /* [헤더와 목록을 따로 읽는다] participations 조회가 실패해도 학생 헤더는 살아 있어야 한다
       (스펙 에러 처리 표). URL 직접 진입·새로고침으로도 동작해야 하므로 목록 화면 상태에 의존하지 않는다. */
    (async () => {
      setHeaderState('loading');
      try {
        const row = await fetchMentoredStudent(studentId);
        if (cancelled) return;
        setStudent(row);
        // 0행 = 담당이 아니거나 존재하지 않는 학생. RLS 가 판정한 결과이지 오류가 아니다.
        setHeaderState(row ? 'ready' : 'notfound');
      } catch (err) {
        console.error('[AdminStudentArchive] 학생 정보 조회 실패:', err);
        if (cancelled) return;
        setStudent(null);
        setHeaderState('error');
      }
    })();

    (async () => {
      setListState('loading');
      try {
        const rows = await fetchCompletedActivitiesOf(studentId);
        if (cancelled) return;
        setActivities(rows);
        setListState('ready');
      } catch (err) {
        console.error('[AdminStudentArchive] 활동 기록 조회 실패:', err);
        if (cancelled) return;
        setActivities([]);
        setListState('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [studentId]);

  /* ---------- PDF (= 브라우저 인쇄) — 결정 G ----------
     라이브러리를 쓰지 않는다. 인쇄 CSS 는 글자가 벡터로 남아 PDF 에서 검색·복사된다. */
  const prevTitle = useRef(null);

  useEffect(() => {
    const restore = () => {
      if (prevTitle.current !== null) {
        document.title = prevTitle.current;
        prevTitle.current = null;
      }
    };
    // 취소도 afterprint 가 온다 — 취소는 실패가 아니다(문구를 띄우지 않는다).
    window.addEventListener('afterprint', restore);
    return () => {
      window.removeEventListener('afterprint', restore);
      restore();
    };
  }, []);

  const handlePrint = useCallback(() => {
    if (!student) return;
    // 브라우저 기본 파일명 = document.title. 바꾸기 전에 원래 값을 먼저 붙잡아 둔다(순서를 바꾸면
    // 복원 시 새 제목이 원래 제목으로 굳는다).
    prevTitle.current = document.title;
    document.title = ['Accumu_활동아카이브', student.name, student.code, todayISO()]
      .filter(Boolean)
      .join('_');
    window.print();
  }, [student]);

  // 담당 해제 (ADR 0015). 성공하면 이 학생이 더 이상 내 담당이 아니므로 목록으로 돌아간다 —
  // 이 페이지에 남아 있어봐야 다음 새로고침에서 headerState가 'notfound'로 떨어질 화면이다.
  const handleRemove = useCallback(async () => {
    if (!student || removing) return;
    setRemoving(true);
    setRemoveError('');
    try {
      await removeMentee(student.id);
      navigate('/admin/mypage');
    } catch (err) {
      console.error('[AdminStudentArchive] 담당 해제 실패:', err);
      setRemoveError('담당 해제에 실패했어요. 잠시 후 다시 시도해 주세요.');
      setRemoving(false);
    }
  }, [student, removing, navigate]);

  // 담당이 아닌/없는 학생 — 404 로 뭉개지 않고 돌아갈 길을 준다.
  if (headerState === 'notfound') {
    return (
      <section className="screen">
        <div className="empty">
          담당 학생이 아니거나 존재하지 않는 학생입니다.
          <br />
          <Link className="adm-backlink" to="/admin/mypage">
            마이페이지로 돌아가기
          </Link>
        </div>
      </section>
    );
  }

  const trackLabel = student?.career_interest
    ? TRACK[student.career_interest]?.name ?? '계열 미설정'
    : '계열 미설정';

  return (
    <section className="screen">
      {/* 인쇄에서만 보이는 문서 머리글 (화면에서는 Archive.css 가 display:none) */}
      <ArchivePrintHeader title={PRINT_TITLE} name={student?.name} code={student?.code} />

      <div className="adm-detailbar no-print">
        <button type="button" className="adm-back" onClick={() => navigate('/admin/mypage')}>
          <Icon name="ic-arrow-left" size={16} />
          마이페이지
        </button>
        <div style={{ display: 'flex', gap: 8 }}>
          {/* [담당 해제 — ADR 0015] 관리자 기능 4번째. 확인 없이 바로 지우지 않는다 — "내리기"와
              같은 2단계(확인 모달) 규율을 그대로 따른다. */}
          {student && (
            <button
              type="button"
              className="adm-removebtn"
              onClick={() => setConfirmingRemove(true)}
              title="이 학생을 담당 목록에서 제외합니다"
            >
              <Icon name="ic-close" size={16} />
              담당 해제
            </button>
          )}
          <button
            type="button"
            className="adm-scanall"
            onClick={handlePrint}
            disabled={!student || activities.length === 0}
            title={
              activities.length === 0
                ? '완료한 활동이 있어야 내보낼 수 있어요'
                : '브라우저 인쇄 대화상자에서 "PDF로 저장"을 고르세요'
            }
          >
            <Icon name="ic-print" size={17} />
            PDF로 확인
          </button>
        </div>
      </div>

      {headerState === 'error' && (
        <div className="empty">
          학생 정보를 불러오지 못했어요.
          <br />
          잠시 후 다시 시도해 주세요.
        </div>
      )}

      {/* 학생 헤더 — 이름·학번·계열 + 포인트 한 줄(ADR 0015). currency_balance는 여전히 조회하지
          않는다 — 요청받은 건 포인트뿐이다. */}
      {student && (
        <div className="adm-studenthead">
          <div className="av" aria-hidden="true">{student.name?.trim()?.[0] ?? ''}</div>
          <div className="who">
            <h3>{student.name}</h3>
            <div className="m">
              {student.code} · {trackLabel}
            </div>
            <div className="pts">
              <Icon name="ic-coin" size={15} color="var(--amber)" />
              {(student.points_balance ?? 0).toLocaleString()}P<em>· 누적 {(student.points_total ?? 0).toLocaleString()}P</em>
            </div>
          </div>
        </div>
      )}

      {/* 마일스톤(결정 F) — 어두운 패널 안이어야 StackViz 의 빈 블록이 보인다(이슈 5).
          600px 이하·인쇄에서는 사라지고 아래 요약 블록이 같은 정보를 텍스트로 전달한다. */}
      {listState === 'ready' && activities.length > 0 && <ArchiveHero completed={activities} />}

      {/* 요약(결정 C / 확정 L-1) — 활동 수 + 유형 분포 + 활동 기간. 게이지·퍼센트·달성률 없음.
          조회 중/실패에는 그리지 않는다 — "총 0"은 사실이 아니라 아직 모르는 상태다. */}
      {listState === 'ready' && activities.length > 0 && <ArchiveSummary activities={activities} />}

      <div className="arc-panel">
        <div className="ph">
          <h3>활동 목록</h3>
          <span className="phnote no-print">QR 입·퇴장 인증이 완료된 활동</span>
        </div>

        {listState === 'loading' && <div className="empty">활동 기록을 불러오는 중…</div>}

        {listState === 'error' && (
          <div className="empty">
            활동 기록을 불러오지 못했어요.
            <br />
            잠시 후 다시 시도해 주세요.
          </div>
        )}

        {listState === 'ready' && (
          <ActivityList
            activities={activities}
            /* onSelect 없음 = 행이 클릭 불가. 관리자에게는 상세 모달이 없다(쓰기·평가 경로가 없으므로
               모달에 담을 것도 없다). reviewByParticipationId / amountByParticipationId 도 넘기지 않는다. */
            showTrack
            emptyText={
              <>
                아직 완료한 활동이 없습니다.
                <br />
                활동은 QR 퇴장 인증이 끝난 뒤 이곳에 자동으로 기록됩니다.
              </>
            }
          />
        )}
      </div>

      {confirmingRemove && student && (
        <RemoveMenteeConfirm
          student={student}
          busy={removing}
          error={removeError}
          onCancel={() => {
            if (!removing) {
              setConfirmingRemove(false);
              setRemoveError('');
            }
          }}
          onConfirm={handleRemove}
        />
      )}
    </section>
  );
}

/* ---------- 담당 해제 확인 창 (ADR 0015 — AdminProgramsPage의 UnpublishConfirm과 같은 패턴) ---------- */
function RemoveMenteeConfirm({ student, busy, error, onCancel, onConfirm }) {
  return (
    <Modal onClose={busy ? () => {} : onCancel} labelledBy="removementee-title" className="confirm-modal">
      <div className="mbody">
        <h3 id="removementee-title">담당을 해제할까요?</h3>
        <p className="confirm-target">
          {student.name} · {student.code}
        </p>
        <p className="confirm-desc">
          더 이상 이 학생의 아카이브를 조회할 수 없게 됩니다. <b>학생의 활동 기록·포인트는 그대로
          유지</b>되며, 학생이 초대코드를 다시 입력하면 (같은 관리자든 다른 관리자든) 담당이 재연결될 수
          있습니다.
        </p>
        {error && (
          <p className="pf-msg err" role="alert">
            {error}
          </p>
        )}
        <div className="pf-actions">
          <button type="button" className="pf-btn ghost" onClick={onCancel} disabled={busy}>
            취소
          </button>
          <button type="button" className="pf-btn danger" onClick={onConfirm} disabled={busy}>
            {busy ? '처리 중…' : '담당 해제'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
