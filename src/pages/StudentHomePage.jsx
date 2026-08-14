// Accumu v2 — 학생 메인 화면(홈) — docs/specs/student-home.md "B. 메인 본문"
// Accumu_prototype.html screen-main(551~581줄) + renderMain()(845줄) 재현.
//
// [절대 원칙 4 — 포트폴리오 > 포인트] 성장/포트폴리오 서사(히어로·마일스톤·추천)를 brand blue로 상단에 두고,
//   포인트 amber는 (1) 나브 우측 구석, (2) 개요 카드 3장 중 1장, (3) 카드 +NNN P 뱃지에서만 노출한다.
//   홈에는 큰 포인트 잔액 배너/대시보드를 두지 않는다 (그건 마이페이지 몫).
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useTutorial } from '../context/TutorialContext';
import Icon from '../components/Icon';
import Modal from '../components/Modal';
import Toast from '../components/Toast';
import StackViz from '../components/student/StackViz';
import ProgramCard from '../components/student/ProgramCard';
import JoinModal from '../components/student/JoinModal';
import {
  applyToProgram,
  fetchApplicantCounts,
  fetchAppliedProgramIds,
  fetchProgramAdminNames,
  fetchRecommendedPrograms,
  fetchTutorialProgram,
} from '../lib/programService';
import { fetchCompletedActivities } from '../lib/participationService';
import '../styles/StudentHome.css';
import '../styles/Tutorial.css';

export default function StudentHomePage() {
  const { profile, session } = useAuth();
  const navigate = useNavigate();
  const tutorial = useTutorial();

  const [programs, setPrograms] = useState([]);
  const [state, setState] = useState('loading'); // 'loading' | 'ready' | 'error'
  // [카드에서 바로 참여 팝업을 연다 — 2026-08-14 케빈 지적]
  //   전에는 추천 카드를 눌러도 onOpen 이 프로그램 선택 화면으로 이동만 시켰다. 카드에 "참여" 버튼까지
  //   달아 놓고 정작 그 자리에서 고를 수 없어, 학생이 방금 본 카드를 목록에서 다시 찾아야 했다.
  //   [프로그램 선택 화면보다 상태가 단순한 이유] 홈 추천은 **이미 신청한 프로그램을 애초에 제외**한다
  //   (확정 D-1 / fetchAppliedProgramIds). 그래서 여기 뜨는 카드는 언제나 "아직 신청 안 한" 것이고,
  //   participation·대기 순번·취소 경로가 성립하지 않는다 — 그 세 가지를 조회하지 않는다.
  const [openProgram, setOpenProgram] = useState(null);
  // program_id -> 신청자 수 (ADR 0016). 팝업의 "신청 현황"과 정원 안내에 쓴다.
  const [applicantCounts, setApplicantCounts] = useState(() => new Map());
  // program_id -> 담당 관리자 이름 (ADR 0023).
  const [adminNames, setAdminNames] = useState(() => new Map());
  const [toast, setToast] = useState(null); // { id, message }
  // 마일스톤 스택 데이터 (확정 B-1). 추천 조회와 독립적으로 실패해도 홈 전체가 죽지 않아야 한다.
  const [completed, setCompleted] = useState([]);
  // [ADR 0021] 신규 학생 가이드 트래커 시작 CTA. 튜토리얼 프로그램에 아직 참여 이력이 없을 때만 보인다 —
  // 이미 한 번이라도 신청했다면(완료 전이든 후든) 다시 권하지 않는다(participations는 1인 1회 unique다).
  const [tutorialCta, setTutorialCta] = useState(null); // {id, title} | null
  // [2026-08-11 개정] "눈에 띄게 + 필수적으로" — 팝업(Modal)으로 먼저 보여준다. "다음에 할게요"로
  // 닫아도 완전히 사라지지 않는다 — 이 state는 이번 마운트(=이번 홈 방문)에서만 팝업을 숨기고,
  // 아래 인라인 카드(.tut-cta)는 계속 남아 있다. 홈에 다시 오거나 재로그인하면 팝업이 또 뜬다 —
  // 완료하기 전까진 계속 눈에 밟히게 하려는 의도다(완전한 강제는 아니다 — 데모 시연 유연성을 위해
  // 언제든 건너뛸 수는 있어야 한다).
  const [modalDismissed, setModalDismissed] = useState(false);

  // 추천 목록 + 팝업이 쓰는 부수 정보를 한 번에 읽는다.
  // [신청 후에도 다시 부른다] 방금 신청한 프로그램은 추천에서 빠져야 한다(확정 D-1) — 안 그러면
  // 신청한 활동이 "참여" 버튼을 단 채 홈에 남는다. 신청자 수도 그 신청만큼 늘어야 한다.
  // 담당 관리자 이름은 내 행동으로 바뀌지 않으므로 여기서 같이 읽되 갱신 대상은 아니다(ADR 0023 결정 4).
  const loadRecommended = useCallback(async () => {
    // fetchApplicantCounts/fetchProgramAdminNames 는 실패를 빈 Map 으로 축약하므로 추천만 throw 한다.
    const [rows, counts, admins] = await Promise.all([
      fetchRecommendedPrograms(profile, 8),
      fetchApplicantCounts(),
      fetchProgramAdminNames(),
    ]);
    return { rows, counts, admins };
  }, [profile]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setState('loading');
      try {
        const { rows, counts, admins } = await loadRecommended();
        if (cancelled) return;
        setPrograms(rows);
        setApplicantCounts(counts);
        setAdminNames(admins);
        setState('ready');
      } catch (err) {
        if (cancelled) return;
        // 마이그레이션 미적용/네트워크 오류 등 — 화면 전체가 깨지지 않도록 섹션만 에러 상태로 둔다.
        console.error('[StudentHome] 추천 프로그램 조회 실패:', err);
        setPrograms([]);
        setState('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadRecommended]);

  // 마일스톤 스택 — 완료된 활동만 (participations_select_own 으로 조회. 새 RLS 정책 0개)
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const rows = await fetchCompletedActivities();
        if (!cancelled) setCompleted(rows);
      } catch (err) {
        // 마이그레이션 미적용 등. 스택은 빈 상태로 두고 홈의 나머지는 그대로 뜬다.
        console.warn('[StudentHome] 완료 활동 조회 실패 — 마일스톤을 빈 상태로 둡니다:', err);
        if (!cancelled) setCompleted([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // [ADR 0021] 튜토리얼 CTA 노출 판정 — 두 조회 다 실패해도(마이그레이션 미적용 등) 조용히 숨긴다.
  // 이 홈 화면이 "신규 학생 온보딩"의 유일한 진입점이라 실패해도 화면 자체는 죽으면 안 된다.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [program, appliedIds] = await Promise.all([fetchTutorialProgram(), fetchAppliedProgramIds()]);
        if (cancelled) return;
        if (program && !appliedIds.has(program.id)) setTutorialCta(program);
      } catch (err) {
        console.warn('[StudentHome] 튜토리얼 CTA 판정 실패 — 숨깁니다:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 히어로 CTA·"전체 보기 →" 전용. 카드 클릭은 더 이상 여기로 오지 않는다(그 자리에서 팝업이 열린다).
  const goPrograms = () => navigate('/student/programs');

  // 안정된 참조여야 Toast 내부의 자동 닫힘 타이머가 부모 리렌더마다 초기화되지 않는다.
  const dismissToast = useCallback(() => setToast(null), []);

  // 신청 — 프로그램 선택 화면의 handleApply 와 같은 결과 처리(문구까지 동일하게 맞춘다. 두 화면이
  // 같은 동작에 다른 말을 하면 학생은 다른 일이 일어났다고 읽는다).
  // [취소 경로는 없다] 위 주석대로 홈 카드는 언제나 미신청 상태라 JoinModal 의 취소 버튼이 뜨지 않는다.
  const handleApply = useCallback(
    async (program) => {
      const studentId = session?.user?.id;
      if (!studentId) throw new Error('로그인 세션이 없어 신청할 수 없습니다.');
      try {
        const result = await applyToProgram({ studentId, programId: program.id });
        setOpenProgram(null);
        // 튜토리얼 프로그램을 여기서 신청했다면 "처음이신가요?" 권유는 더 이상 맞지 않는다
        // (다음 로드에서 어차피 빠지지만, 지금 화면에서도 바로 사라져야 말이 된다).
        setTutorialCta((prev) => (prev && prev.id === program.id ? null : prev));
        setToast({
          id: Date.now(),
          message:
            result === 'duplicate'
              ? '이미 신청한 프로그램이에요'
              : result === 'waitlisted'
                ? '정원이 가득 차 대기 명단에 등록됐어요'
                : '신청이 완료되었어요 · 마이페이지에서 QR을 확인하세요',
        });

        // 목록 갱신 실패가 "신청 실패"로 보이면 안 된다 — 신청 자체는 이미 성공했다.
        try {
          const { rows, counts, admins } = await loadRecommended();
          setPrograms(rows);
          setApplicantCounts(counts);
          setAdminNames(admins);
        } catch (err) {
          console.warn('[StudentHome] 신청 후 추천 갱신 실패 — 목록이 잠시 낡을 수 있습니다:', err);
        }
        return result;
      } catch (err) {
        // 팝업이 사용자에게 실패를 알리도록 다시 던진다(원본은 여기서 콘솔에 남긴다).
        console.error('[StudentHome] 신청 실패:', err);
        throw err;
      }
    },
    [session?.user?.id, loadRecommended]
  );

  // career_interest가 없으면 추천이 최신순 fallback으로 동작하므로(확정 E) 카피도 사실대로 바꾼다.
  const hasInterest = Boolean(profile?.career_interest);
  const recoSub = hasInterest
    ? `${profile?.name ?? ''}님의 관심 분야를 바탕으로 골라봤어요`
    : '새로 등록된 프로그램을 모아봤어요';

  return (
    <section className="screen">
      {/* ===== 신규 학생 가이드 트래커 시작 CTA (ADR 0021) =====
          [트래커가 이미 켜져 있으면 다시 안 보여준다] 배너 자체가 "시작해볼까요?" 권유라, 이미
          시작한 학생에게 또 보이면 이중 초대가 된다. */}
      {tutorialCta && !tutorial.active && (
        <div className="tut-cta">
          <div className="tut-cta-ic" aria-hidden="true">
            <Icon name="ic-compass" size={20} color="var(--brand)" />
          </div>
          <div className="tut-cta-body">
            <h4>Accumu가 처음이신가요?</h4>
            <p>신청부터 QR 인증, 포인트 적립까지 짧은 연습으로 사용법을 익혀보세요.</p>
          </div>
          <button
            type="button"
            className="tut-cta-btn"
            onClick={() => {
              tutorial.start();
              setTutorialCta(null);
            }}
          >
            시작하기
          </button>
        </div>
      )}

      {/* [2026-08-11] 팝업 버전 — 홈에 올 때마다(완료 전까지) 눈에 띄게 먼저 띄운다. 위 인라인
          카드와 같은 조건에 modalDismissed(이번 방문 한정)만 더 본다. */}
      {tutorialCta && !tutorial.active && !modalDismissed && (
        <Modal onClose={() => setModalDismissed(true)} labelledBy="tut-start-title" className="confirm-modal">
          <div className="mbody tut-start-modal">
            <div className="tut-cta-ic lg" aria-hidden="true">
              <Icon name="ic-compass" size={28} color="var(--brand)" />
            </div>
            <h3 id="tut-start-title">Accumu가 처음이신가요?</h3>
            <p className="confirm-desc">
              가입을 환영해요! 신청부터 QR 입·퇴장 인증, 포인트 적립, 디지털 아카이브 기록까지 —
              짧은 연습으로 Accumu 사용법을 먼저 익혀보세요.
            </p>
            <button
              type="button"
              className="mbtn"
              onClick={() => {
                tutorial.start();
                setTutorialCta(null);
                setModalDismissed(true);
              }}
            >
              지금 시작하기
            </button>
            <button type="button" className="tut-start-later" onClick={() => setModalDismissed(true)}>
              다음에 할게요
            </button>
          </div>
        </Modal>
      )}

      {/* ===== 히어로 (성장/포트폴리오 서사 — brand blue 우선) ===== */}
      <div className="hero">
        <div className="glow" />
        <div>
          <div className="eyebrow">Accumulate your activity</div>
          <h1>
            참여가 쌓여
            <br />
            <b>나의 커리어</b>가 된다
          </h1>
          <p>
            학교 안팎의 활동에 참여하고, 지역화폐 포인트를 모으고, 흩어져 있던 나의 활동을 하나의 디지털
            포트폴리오로 완성하세요.
          </p>
          <div className="cta">
            <button type="button" className="g" onClick={goPrograms}>
              <Icon name="ic-compass" size={18} />
              프로그램 둘러보기
            </button>
            <button type="button" className="o" onClick={() => navigate('/student/archive')}>
              <Icon name="ic-folder" size={18} />
              내 아카이브 보기
            </button>
          </div>
        </div>
        <StackViz completed={completed} />
      </div>

      {/* ===== 개요 카드 3종 — 포인트(amber)는 3장 중 1장으로만 (원칙 4) ===== */}
      <div className="overview">
        <div className="ov">
          <div className="ic" style={{ background: 'var(--brand-soft)' }}>
            <Icon name="ic-target" size={22} color="var(--brand)" />
          </div>
          <h4>활동을 찾고 참여</h4>
          {/* [문구가 실제 유형 4종을 따라간다 — 2026-08-14 수정]
              예전 문구는 "방과후·동아리·봉사·기업 프로그램까지" 였다. 방과후는 ADR 0014 가 **의도적으로
              뺀** 것이다 — 참여에 비용이 드는 활동을 포인트로 보상하면 "돈 내고 포인트 사는" 구조가 된다.
              앱의 첫 화면이 없는 것을, 그것도 원칙상 배제한 것을 광고하고 있었다.
              >>> 이 줄은 CAT 4종(교내 활동 · 대회·공모전 · 봉사활동 · 진로 체험)을 풀어 쓴 것이다.
                  taxonomy.js 의 CAT 이 바뀌면 여기도 같이 볼 것. */}
          <p>동아리·대회·봉사부터 기업·대학 진로 체험까지, 진로에 도움되는 활동을 유형별로 모아봅니다.</p>
        </div>
        <div className="ov">
          <div className="ic" style={{ background: 'var(--amber-soft)' }}>
            <Icon name="ic-coin" size={22} color="var(--amber)" />
          </div>
          <h4>지역화폐 포인트</h4>
          <p>입장·퇴장 QR을 인증하면 참여가 확인되고, 분야별 포인트가 정직하게 쌓입니다.</p>
        </div>
        <div className="ov">
          <div className="ic" style={{ background: 'var(--indigo-soft)' }}>
            <Icon name="ic-folder" size={22} color="var(--indigo)" />
          </div>
          <h4>디지털 포트폴리오</h4>
          <p>참여 이력이 자동으로 정리되고, 진로·진학에 쓰는 PDF 포트폴리오로 내려받습니다.</p>
        </div>
      </div>

      {/* ===== 추천 프로그램 ===== */}
      <div className="sec-head">
        <div>
          <div className="eyebrow">Recommended</div>
          <h2 className="sec">추천 프로그램</h2>
          <div className="sec-sub">{recoSub}</div>
        </div>
        <button type="button" className="join-btn seeall" onClick={goPrograms}>
          전체 보기 →
        </button>
      </div>

      {state === 'loading' && <div className="empty">추천 프로그램을 불러오는 중…</div>}

      {state === 'error' && (
        <div className="empty">
          추천 프로그램을 불러오지 못했어요.
          <br />
          잠시 후 다시 시도해 주세요.
        </div>
      )}

      {state === 'ready' &&
        (programs.length === 0 ? (
          // 빈 상태 문구는 프로토타입 849줄 카피 그대로
          <div className="empty">
            지금 추천할 새 프로그램이 없어요.
            <br />곧 새로운 프로그램이 등록됩니다.
          </div>
        ) : (
          <div className="cards-row">
            {programs.map((p) => (
              // applicantCount 를 넘긴다 — 넘기지 않으면 카드가 "N명 신청" 줄을 통째로 숨긴다(기본값 null).
              // 팝업에서 신청 현황을 보여주면서 카드에서만 감출 이유가 없다.
              <ProgramCard
                key={p.id}
                program={p}
                applicantCount={applicantCounts.get(p.id) ?? 0}
                onOpen={() => setOpenProgram(p)}
              />
            ))}
          </div>
        ))}

      {/* 참여 팝업 — 프로그램 선택 화면과 같은 컴포넌트다(문구·규칙이 갈라지지 않게).
          participation/waitlistPosition/onCancel 을 넘기지 않는 이유는 위 state 선언부 주석 참고. */}
      {openProgram && (
        <JoinModal
          program={openProgram}
          applicantCount={applicantCounts.get(openProgram.id) ?? 0}
          adminName={adminNames.get(openProgram.id) ?? null}
          onClose={() => setOpenProgram(null)}
          onApply={handleApply}
        />
      )}

      {toast && <Toast key={toast.id} message={toast.message} onDone={dismissToast} />}
    </section>
  );
}
