// Accumu v2 — 신규 학생 가이드 트래커 전역 상태 (docs/adr/0021-onboarding-tutorial.md)
//
// [가벼운 단계 트래커다 — 완전한 인터랙티브 투어가 아니다] 실제 버튼을 하이라이트하고 순서대로 안내하지만,
//   화살표·말풍선으로 화면을 짚어주는 무거운 투어 엔진은 아니다(케빈이 명시적으로 가벼운 쪽을 골랐다).
//   "다음 단계로 넘기는" 판정은 대부분 근사치다 — 예를 들어 2단계는 "신청 버튼을 눌렀다"까지만 보고
//   실제 신청 성공 여부는 다시 확인하지 않는다. 데모용 트래커이지 상태 기계가 아니다.
// [학생 전용] StudentLayout 안에서만 마운트된다 — 관리자 화면에는 이 컨텍스트 자체가 없다.
// [진행 상태는 로그인한 학생별로 localStorage에 남는다] 새로고침해도 트래커가 초기화되지 않는다.
//   "시작했는가"와 "몇 단계인가"만 남기고, "완료했는가"는 이 컨텍스트가 판단하지 않는다 — 그건
//   실제로 참여가 완료됐는지 DB로 확인할 문제라 홈 화면이 fetchTutorialProgram()+참여 여부로 따로 본다.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useAuth } from './AuthContext';

const TutorialContext = createContext(undefined);

const STORAGE_PREFIX = 'accumu_tutorial_v1_';

// [12단계 — 케빈이 준 순서 그대로] manual: true인 단계는 클릭으로 넘어갈 다음 버튼이 없는 "설명만"
//   단계라 트래커 배너 자체에 다음/완료 버튼을 둔다. 나머지는 data-tutorial 속성이 붙은 실제 버튼을
//   누르면 TutorialOverlay의 전역 클릭 리스너가 advance()를 부른다.
export const TUTORIAL_STEPS = [
  { n: 1, text: '위에서 "프로그램" 버튼을 눌러보세요.' },
  { n: 2, text: '목록에서 "Accumu 사용법 알아보기"를 찾아 신청해보세요.' },
  { n: 3, text: '알림 버튼을 눌러 신청 알림이 왔는지 확인해보세요.' },
  { n: 4, text: '"마이페이지" 버튼을 눌러보세요.' },
  { n: 5, text: '"QR 확인" 버튼을 누르고 입장 QR을 열어보세요.' },
  { n: 6, text: 'QR이 자동으로 인증돼요. 확인했으면 "목록으로"를 눌러보세요.' },
  { n: 7, text: '이번엔 퇴장 QR을 눌러보세요.' },
  { n: 8, text: '만족도와 한줄평을 남겨보세요(건너뛰어도 괜찮아요).' },
  { n: 9, text: '"내 활동 아카이브 보기"를 눌러보세요.' },
  {
    n: 10,
    text: '방금 완료한 활동이 아카이브에 기록됐어요. 이렇게 쌓인 활동이 나만의 포트폴리오가 됩니다.',
    manual: true,
  },
  { n: 11, text: '다시 "마이페이지" 버튼을 눌러보세요.' },
  {
    n: 12,
    text: '방금 적립된 포인트는 다음 달 말일에 지역화폐로 자동 전환돼요. 튜토리얼이 끝났어요!',
    manual: true,
    isLast: true,
  },
];

const IDLE = { active: false, step: 1 };

function loadState(key) {
  if (!key) return IDLE;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return IDLE;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.step !== 'number' || parsed.step < 1 || parsed.step > TUTORIAL_STEPS.length) return IDLE;
    return { active: Boolean(parsed.active), step: parsed.step };
  } catch {
    return IDLE;
  }
}

function saveState(key, next) {
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // 프라이빗 모드 등으로 저장이 막혀도 트래커는 이번 세션 동안은 그대로 동작한다 — 무시한다.
  }
}

export function TutorialProvider({ children }) {
  const { profile } = useAuth();
  // 계정마다 독립된 진행 상태 — 같은 브라우저에서 학생 계정을 오갈 때 서로 섞이지 않는다.
  const storageKey = profile?.id ? `${STORAGE_PREFIX}${profile.id}` : null;

  const [state, setState] = useState(IDLE);

  useEffect(() => {
    setState(loadState(storageKey));
  }, [storageKey]);

  const start = useCallback(() => {
    const next = { active: true, step: 1 };
    setState(next);
    saveState(storageKey, next);
  }, [storageKey]);

  const advance = useCallback(() => {
    setState((prev) => {
      if (!prev.active) return prev;
      const next = prev.step >= TUTORIAL_STEPS.length ? IDLE : { active: true, step: prev.step + 1 };
      saveState(storageKey, next);
      return next;
    });
  }, [storageKey]);

  const stop = useCallback(() => {
    setState(IDLE);
    saveState(storageKey, IDLE);
  }, [storageKey]);

  const value = useMemo(() => {
    const stepConfig = state.active ? TUTORIAL_STEPS[state.step - 1] : null;
    return {
      active: state.active,
      step: state.step,
      stepConfig,
      // 컴포넌트가 "지금 내가 하이라이트 대상인가"만 물을 수 있게 — 매 컴포넌트가 state 구조를 몰라도 된다.
      isStep: (n) => state.active && state.step === n,
      start,
      advance,
      stop,
    };
  }, [state, start, advance, stop]);

  return <TutorialContext.Provider value={value}>{children}</TutorialContext.Provider>;
}

/** [Provider 밖에서 부르면 즉시 에러다] StudentLayout 안에서만 쓰라는 뜻을 코드로 강제한다 — 관리자
 *  화면 컴포넌트가 실수로 이 훅을 쓰면(복붙 등) 조용히 무해하게 실패하는 대신 바로 드러난다. */
export function useTutorial() {
  const ctx = useContext(TutorialContext);
  if (!ctx) throw new Error('useTutorial()은 TutorialProvider(학생 화면) 안에서만 쓸 수 있습니다.');
  return ctx;
}
