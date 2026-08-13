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
// [2026-08-13 개정 — 설명 보강] 원래는 "어디를 누르라"는 동작 지시문 한 줄이 전부였다. 케빈 피드백
//   ("설명이 빈약하다")에 따라 각 단계에 "왜 이 기능이 있는가"를 한두 문장 더 붙였다 — 버튼 위치를
//   외우는 튜토리얼이 아니라 Accumu의 실제 규칙(QR 이중 인증·대기열·월간 정산 등)을 같이 이해하고
//   넘어가게 하려는 목적이다. 버튼 라벨(예: "참석 신청하기", "입장 QR")은 실제 화면 문구와 정확히
//   맞춘다 — 다르면 학생이 뭘 눌러야 할지 다시 헤맨다.
// [2026-08-13 — 두 셸에서 동시에 맞아야 한다] 메뉴는 데스크톱 상단 메뉴와 모바일 하단 탭바에
//   두 벌 있고 라벨이 다르다("디지털 아카이브" ↔ "아카이브"). 안내문은 **양쪽에서 다 통하는 말**로
//   쓴다 — 그래서 9단계는 "아카이브"다. 방향 표현도 넣지 않는다: 같은 메뉴가 데스크톱에서는 위,
//   모바일에서는 아래에 있어 "위쪽 ○○ 메뉴"는 절반의 화면에서 거짓말이 된다(1단계에서 그랬다).
export const TUTORIAL_STEPS = [
  {
    n: 1,
    text: '"프로그램" 메뉴를 눌러보세요. 학교 안팎의 동아리·봉사·대회·진로체험 활동이 카테고리별로 모여 있는 목록이에요.',
  },
  {
    n: 2,
    text: '목록에서 "Accumu 사용법 알아보기"를 찾아 열고, "참석 신청하기" 버튼까지 눌러 신청을 완료해보세요. 정원이 다 찬 프로그램은 자동으로 대기열에 등록되고, 다른 학생이 취소하면 대기 순번대로 자동 승격돼요.',
  },
  {
    n: 3,
    text: '종 모양 알림 버튼을 눌러 방금 신청한 알림이 왔는지 확인해보세요. 신청 확정뿐 아니라 QR 인증 안내·대기열 승격·일정 변경 같은 소식도 모두 여기로 모여요.',
  },
  {
    n: 4,
    text: '"마이페이지" 메뉴를 눌러보세요. 내 포인트 잔액과 지역화폐 전환 현황, 계정 정보를 관리하는 곳이에요.',
  },
  {
    n: 5,
    text: '"QR 확인" 버튼을 누른 뒤, 방금 신청한 활동의 "입장 QR" 버튼을 눌러보세요. 실제 프로그램에서는 이 QR을 관리자가 카메라로 스캔해 입장을 인증해요.',
  },
  {
    n: 6,
    text: '이 프로그램은 튜토리얼이라 QR이 자동으로 인증돼요. 실제 프로그램은 관리자가 직접 스캔해야만 인증되고, 부정 참여를 막기 위해 입장·퇴장을 각각 따로 확인해요. 확인했으면 "목록으로"를 눌러보세요.',
  },
  {
    n: 7,
    text: '이번엔 같은 방식으로 "퇴장 QR"을 눌러보세요. 입장과 퇴장이 모두 인증돼야 참여가 완료 처리되고 포인트가 지급돼요.',
  },
  {
    n: 8,
    text: '만족도(별점)와 한줄평을 남겨보세요. 이 평가는 본인만 볼 수 있고, 건너뛰어도 활동 기록 자체에는 영향이 없어요.',
  },
  {
    n: 9,
    text: '"아카이브" 메뉴를 눌러보세요. 입·퇴장 인증이 끝난 활동이 자동으로 정리·기록되는 곳이에요.',
  },
  {
    n: 10,
    text: '방금 완료한 활동이 아카이브에 기록됐어요. 이렇게 쌓인 활동 기록은 언제든 PDF로 내려받아 진로·진학에 쓰는 포트폴리오로 활용할 수 있어요.',
    manual: true,
  },
  { n: 11, text: '다시 "마이페이지" 메뉴를 눌러 방금 적립된 포인트를 확인해보세요.' },
  {
    n: 12,
    text: '적립된 포인트는 이번 달이 끝나고 다음 달 말일에 지역화폐로 자동 전환돼요. 전환 시점과 금액을 직접 고르는 게 아니라, 그달 적립분 전액이 그대로 자동 전환되는 방식이에요. 튜토리얼이 모두 끝났어요 — 이제 실제 프로그램에 참여해보세요!',
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
