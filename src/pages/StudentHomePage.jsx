// Accumu v2 — 학생 메인 화면(홈) — docs/specs/student-home.md "B. 메인 본문"
// Accumu_prototype.html screen-main(551~581줄) + renderMain()(845줄) 재현.
//
// [절대 원칙 4 — 포트폴리오 > 포인트] 성장/포트폴리오 서사(히어로·마일스톤·추천)를 brand blue로 상단에 두고,
//   포인트 amber는 (1) 나브 우측 구석, (2) 개요 카드 3장 중 1장, (3) 카드 +NNN P 뱃지에서만 노출한다.
//   홈에는 큰 포인트 잔액 배너/대시보드를 두지 않는다 (그건 마이페이지 몫).
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import Icon from '../components/Icon';
import StackViz from '../components/student/StackViz';
import ProgramCard from '../components/student/ProgramCard';
import { fetchRecommendedPrograms } from '../lib/programService';
import { fetchCompletedActivities } from '../lib/participationService';
import '../styles/StudentHome.css';

export default function StudentHomePage() {
  const { profile } = useAuth();
  const navigate = useNavigate();

  const [programs, setPrograms] = useState([]);
  const [state, setState] = useState('loading'); // 'loading' | 'ready' | 'error'
  // 마일스톤 스택 데이터 (확정 B-1). 추천 조회와 독립적으로 실패해도 홈 전체가 죽지 않아야 한다.
  const [completed, setCompleted] = useState([]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setState('loading');
      try {
        const rows = await fetchRecommendedPrograms(profile, 8);
        if (cancelled) return;
        setPrograms(rows);
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
  }, [profile]);

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

  // 확정 B: 카드/전체 보기 클릭 -> 프로그램 선택 화면 경로로 라우팅 (대상은 아직 placeholder).
  const goPrograms = () => navigate('/student/programs');

  // career_interest가 없으면 추천이 최신순 fallback으로 동작하므로(확정 E) 카피도 사실대로 바꾼다.
  const hasInterest = Boolean(profile?.career_interest);
  const recoSub = hasInterest
    ? `${profile?.name ?? ''}님의 관심 분야를 바탕으로 골라봤어요`
    : '새로 등록된 프로그램을 모아봤어요';

  return (
    <section className="screen">
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
          <p>방과후·동아리·봉사·기업 프로그램까지, 진로에 도움되는 활동을 카테고리별로 모아봅니다.</p>
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
              <ProgramCard key={p.id} program={p} onOpen={goPrograms} />
            ))}
          </div>
        ))}
    </section>
  );
}
