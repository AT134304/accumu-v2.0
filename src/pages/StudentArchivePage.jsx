// Accumu v2 — 학생 디지털 아카이브 (docs/specs/student-archive-mypage.md A절 / 확정 K-1·L-1·M-1)
// Accumu_prototype.html screen-archive(604~628줄) + renderArchive()(1247줄) 재현.
//
// [이 화면이 프로젝트의 정체성이다 — 절대 원칙 4]
//   화면 첫 블록은 성장(brand blue / indigo)이고, 요약 3칸은 **활동 수**이지 포인트가 아니다.
//   포인트 총액 칸을 요약에 넣지 않는다(질문 L 결과와 무관하게 고정). PDF 에도 포인트가 남지 않는다.
//
// [이번 범위에서 뺀 것 — 근거 있는 보류]
//   1. 활동 행의 포인트(확정 L-1): 값의 소스는 point_transactions.amount(지급 시점 스냅샷)인데
//      그 테이블은 현재 **select 정책이 0개**라 학생 본인도 읽을 수 없다. programs.points 로 대신하면
//      관리자가 프로그램 포인트를 수정한 순간 이미 지급된 금액과 어긋난다(ADR 0005 결정 3-6 "틀린 숫자").
//      → point_transactions_select_own 이 생긴 뒤 ActivityList.jsx 의 "[자리 — 포인트]"에 붙인다.
//   2. 별점/한줄평(결정 D): reviews 테이블 자체가 아직 없다.
//      → ActivityList.jsx "[자리 — 평가 줄]" / ActivityDetailModal.jsx "[자리 — 나의 만족도]".
//   둘 다 새 정책·마이그레이션이 필요한 항목이라 이 화면은 **기존 권한만으로** 성립한다.
//
// [원칙 1 가드] 막대 게이지·퍼센트·달성률·등급·숫자 카운트업·랭킹·다른 학생 비교가 없다.
//   진로 계열 레이더(TrackRadar)는 **확정 M-2로 추가**됐고 건수만 그린다 — 그 가드는 그 안에도 걸려 있다.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import Icon from '../components/Icon';
import ArchiveHero from '../components/archive/ArchiveHero';
import ArchiveSummary from '../components/archive/ArchiveSummary';
import TrackRadar from '../components/archive/TrackRadar';
import ActivityList from '../components/archive/ActivityList';
import ArchivePrintHeader from '../components/archive/ArchivePrintHeader';
import ActivityDetailModal from '../components/student/ActivityDetailModal';
import { fetchMyCompletedActivities } from '../lib/archiveService';
import { todayISO } from '../lib/date';
import '../styles/StudentArchive.css';

const PRINT_TITLE = 'Accumu 디지털 활동 포트폴리오';

export default function StudentArchivePage() {
  const { profile } = useAuth();
  const navigate = useNavigate();

  const [activities, setActivities] = useState([]);
  const [state, setState] = useState('loading'); // 'loading' | 'ready' | 'error'
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setState('loading');
      try {
        // participations_select_own 이 소유자다 — student_id 를 클라이언트에서 걸지 않는다.
        // programs 는 클라이언트 결합(뷰/embed 금지 — 정의자 권한 함정).
        const rows = await fetchMyCompletedActivities();
        if (cancelled) return;
        setActivities(rows);
        setState('ready');
      } catch (err) {
        // 조회 실패는 "완료 0건"과 전혀 다른 상태다. 빈 상태 문구를 실패에 쓰지 않는다.
        console.error('[StudentArchive] 활동 기록 조회 실패:', err);
        if (cancelled) return;
        setActivities([]);
        setState('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const total = activities.length;

  /* ---------- PDF (= 브라우저 인쇄) ----------
     라이브러리를 쓰지 않는다. jsPDF 는 한글 폰트를 임베딩해야 하고 html2canvas 는 글자를 이미지로 만든다.
     인쇄 CSS 는 텍스트가 벡터로 남아 PDF 에서 검색·복사된다 (admin-students 결정 G). */
  const prevTitle = useRef(null);

  // 인쇄 대화상자가 닫히면 document.title 을 되돌린다. 취소도 afterprint 가 온다 — 취소는 실패가 아니다.
  useEffect(() => {
    const restore = () => {
      if (prevTitle.current !== null) {
        document.title = prevTitle.current;
        prevTitle.current = null;
      }
    };
    window.addEventListener('afterprint', restore);
    // 인쇄 중에 화면을 벗어나도 제목이 남지 않게 언마운트에서도 복원한다.
    return () => {
      window.removeEventListener('afterprint', restore);
      restore();
    };
  }, []);

  const handlePrint = useCallback(() => {
    if (total === 0) return;
    // 브라우저 기본 파일명 = document.title. 그대로 쓸 만한 이름으로 바꿔둔다.
    const name = profile?.name?.trim() || '학생';
    const code = profile?.code?.trim() || '';
    prevTitle.current = document.title;
    document.title = ['Accumu_활동포트폴리오', name, code, todayISO()].filter(Boolean).join('_');
    window.print();
  }, [profile, total]);

  return (
    <section className="screen arc-screen">
      {/* 인쇄에서만 보이는 문서 머리글 (화면에서는 display:none) */}
      <ArchivePrintHeader title={PRINT_TITLE} name={profile?.name} code={profile?.code} />

      <div className="sec-head no-print">
        <div>
          <div className="eyebrow">Digital archive</div>
          <h2 className="sec">디지털 아카이브</h2>
          <div className="sec-sub">참여한 활동이 자동으로 기록됩니다</div>
        </div>
        <button
          type="button"
          className="arc-pdfbtn"
          onClick={handlePrint}
          disabled={total === 0}
          title={total === 0 ? '완료한 활동이 있어야 내보낼 수 있어요' : '브라우저 인쇄 대화상자에서 "PDF로 저장"을 고르세요'}
        >
          <Icon name="ic-doc" size={18} />
          PDF로 저장
        </button>
      </div>

      {/* 어두운 히어로 + 마일스톤. 600px 이하·인쇄에서는 숨고 아래 요약이 그 역할을 한다. */}
      <ArchiveHero completed={activities} />

      {/* 요약 — 활동 수 3칸 + 유형 분포 + 활동 기간 (사실 기술만).
          조회 실패/로딩 중에는 그리지 않는다 — "총 참여 활동 0"은 사실이 아니라 아직 모르는 상태다. */}
      {state === 'ready' && <ArchiveSummary activities={activities} />}

      {/* 진로 계열별 레이더 (확정 M-2).
          [위치] 요약(숫자) 바로 아래, 활동 목록 위 = 화면 상단부. 원칙 4대로 포인트보다 성장이 먼저다.
            - .arc-hero(어두움)는 "언제 활동했나"(시간축), 요약은 "얼마나"(총량), 레이더는 "어느 계열로"(분포),
              목록은 "무엇을"(개별 사실). 위계가 겹치지 않는다.
            - 어두운 히어로 안에 넣지 않는다 — 인쇄에 남겨야 하고(print.css), .arc-hero 는 인쇄에서 숨는다.
          [빈 상태] 그릴 값이 0이면 TrackRadar 가 스스로 null 을 반환한다. 여기서 조건을 중복해 걸지 않는다
            — 판정 기준(계열을 알 수 없는 건 제외)이 컴포넌트 안에 있어서 두 곳에 두면 갈라진다. */}
      {state === 'ready' && <TrackRadar activities={activities} />}

      <div className="arc-panel">
        <div className="ph">
          <h3>활동 목록</h3>
          <span className="phnote no-print">QR 입·퇴장 인증이 완료된 활동</span>
        </div>

        {state === 'loading' && <div className="empty">활동 기록을 불러오는 중…</div>}

        {state === 'error' && (
          <div className="empty">
            활동 기록을 불러오지 못했어요.
            <br />
            잠시 후 다시 시도해 주세요.
          </div>
        )}

        {state === 'ready' &&
          (total === 0 ? (
            <ArchiveEmpty onExplore={() => navigate('/student/programs')} />
          ) : (
            <ActivityList activities={activities} onSelect={setSelected} />
          ))}
      </div>

      {selected && <ActivityDetailModal activity={selected} onClose={() => setSelected(null)} />}
    </section>
  );
}

/**
 * 빈 상태 — 이 프로젝트에서는 **기본 상태**다.
 * 가짜 참여를 시드하지 않기로 확정돼 있어(ADR 0004/0005) 시연 첫 화면이 여기일 수 있다.
 * 그래서 "왜 비어 있는지 + 무엇을 하면 채워지는지"를 화면이 스스로 설명한다.
 * [원칙 1] "0개 달성" 류 진척 표현을 쓰지 않는다. 실패 문구도 아니다(에러와 구분).
 */
function ArchiveEmpty({ onExplore }) {
  return (
    <div className="arc-empty">
      <div className="ic">
        <Icon name="ic-folder" size={26} color="var(--brand)" />
      </div>
      <h4>아직 기록된 활동이 없어요</h4>
      <p>
        프로그램에 참여하고 <b>입장 · 퇴장 QR</b>을 모두 인증하면
        <br />
        그 활동이 이곳에 자동으로 기록됩니다.
      </p>
      <button type="button" className="arc-emptycta no-print" onClick={onExplore}>
        <Icon name="ic-compass" size={18} />
        프로그램 둘러보기
      </button>
      <div className="steps no-print" aria-hidden="true">
        <span>프로그램 신청</span>
        <i />
        <span>입장 QR 인증</span>
        <i />
        <span>퇴장 QR 인증</span>
        <i />
        <span>아카이브 기록</span>
      </div>
    </div>
  );
}
