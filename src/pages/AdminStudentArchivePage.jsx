// Accumu v2 — 담당 학생 아카이브 상세 (docs/specs/admin-students.md B절 / 결정 A·C·D·F·G·H·J)
//
// [한 화면에 학생이 1명만 존재한다 — 결정 A]
//   목록에서 들어오는 순간 계정 정보와 나머지 4명이 화면에서 사라진다. 비교 UI를 만들려야 만들 수 없고,
//   인쇄 대상도 "지금 이 페이지"로 자명해진다. 마스터-디테일 2단 레이아웃을 쓰지 않는 이유가 이것이다.
//
// [★ 포인트를 표시하지 않는다 — 확정 K-1 / 결정 D]
//   건별도, 합계도 없다. 이 화면은 "무슨 활동을 했는가"이지 "얼마 벌었는가"가 아니다(원칙 4).
//   조회 단계에서도 막혀 있다: 학생 프로필은 points_* 컬럼을 select 하지 않고(archiveService),
//   programs 는 points 를 가져오지 않으며, point_transactions 는 관리자에게 정책이 없어 항상 0행이다.
//   ActivityList 에 amountByParticipationId 를 넘기지 않는 것이 그 규율의 마지막 한 줄이다.
//
// [별점·한줄평도 없다 — student-archive-mypage 결정 E]
//   reviews_select_own 이 "본인 참여의 리뷰"만 열어 관리자는 담당 학생 것도 읽을 수 없다.
//   그래서 reviewByParticipationId 도 넘기지 않는다(넘길 데이터를 얻을 수도 없다).
//
// [쓰기 동작 0개] 코멘트·확인 도장·활동 추가가 없다. participations 에 관리자 update 정책이 0개다.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import Icon from '../components/Icon';
import ArchiveHero from '../components/archive/ArchiveHero';
import ArchiveSummary from '../components/archive/ArchiveSummary';
import ArchivePrintHeader from '../components/archive/ArchivePrintHeader';
import ActivityList from '../components/archive/ActivityList';
import { TRACK } from '../lib/taxonomy';
import { fetchCompletedActivitiesOf, fetchMentoredStudent } from '../lib/archiveService';
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

      {headerState === 'error' && (
        <div className="empty">
          학생 정보를 불러오지 못했어요.
          <br />
          잠시 후 다시 시도해 주세요.
        </div>
      )}

      {/* 학생 헤더 — 이름·학번·계열까지다. points_balance / points_total / currency_balance 는
          애초에 조회하지도 않는다(결정 D / 이슈 4). */}
      {student && (
        <div className="adm-studenthead">
          <div className="av" aria-hidden="true">{student.name?.trim()?.[0] ?? ''}</div>
          <div className="who">
            <h3>{student.name}</h3>
            <div className="m">
              {student.code} · {trackLabel}
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
    </section>
  );
}
