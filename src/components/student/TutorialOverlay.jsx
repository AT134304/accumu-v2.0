// Accumu v2 — 가이드 트래커 오버레이 (docs/adr/0021-onboarding-tutorial.md)
//
// [하는 일 둘뿐] 1) 현재 단계의 data-tutorial="N" 요소를 찾아 하이라이트 링을 그 위에 그린다.
//   2) 그 요소(또는 자손)를 클릭하면 전역 클릭 리스너가 감지해 다음 단계로 넘긴다 — 클릭을
//   가로채지 않는다(preventDefault 없음), 그래서 실제 버튼 동작은 평소와 완전히 같다.
// [Modal.jsx와 같은 이유로 body에 포털한다] 학생 화면(.screen)은 진입 애니메이션에 transform이
//   있어 그 자손에서는 position:fixed가 뷰포트가 아니라 .screen 기준이 된다. 배너/링이 어디서
//   렌더되든 뷰포트 기준으로 고정되려면 body로 빼야 한다.
//
// [data-tutorial-pre — 하이라이트 전용, 진행 트리거 아님 (버그 수정, 2026-08-11)]
//   일부 단계는 "두 번 클릭해야 진짜 다음 단계로 넘어가는" 중간 버튼이 있다(예: 2단계 — 프로그램
//   목록에서 카드를 먼저 열고, 그 안의 "신청하기"를 눌러야 실제로 신청된다). 중간 버튼(카드)까지
//   data-tutorial(진행 트리거)로 잡으면 카드를 여는 순간 다음 단계로 잘못 넘어간다. 그래서 중간
//   버튼은 "하이라이트만" 받는 별도 속성을 쓴다 — 진행 목표(data-tutorial)가 아직 DOM에 없을 때만
//   링의 대체 위치로 쓰인다(목표가 나타나는 순간 그쪽으로 자연히 넘어간다).
//
// ============================================================================
// [모바일 대응 — 2026-08-13, 케빈 "모바일에서 튜토리얼 최적화가 안 되어있어"]
//   좁은 화면에서 트래커가 제 역할을 못 하던 이유 4가지를 여기서 고친다. 자세한 배경은
//   각 함수/블록 주석에.
//     1) 링이 화면 좌상단 구석에 찍혔다 (숨겨진 데스크톱 메뉴를 대상으로 골라서) → visibleTarget()
//     2) 목표가 접힌 스크롤 아래에 있으면 아무것도 안 빛났다              → scrollIntoView 1회
//     3) 하단 배너가 목표 버튼을 덮었다                                    → .avoid 로 위로 피함
//     4) 초당 60번 리렌더                                                  → DOM 직접 갱신
// ============================================================================
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { TUTORIAL_STEPS, useTutorial } from '../../context/TutorialContext';
import '../../styles/Tutorial.css';

/**
 * 같은 단계 번호가 붙은 요소들 중 **화면에 실제로 보이는** 것 하나를 고른다.
 *
 * [querySelector 로는 안 되는 이유 — 모바일 하이라이트 버그]
 *   메뉴 링크에는 같은 단계 번호가 **두 벌** 붙어 있다: 데스크톱 상단 메뉴(`.nav .menu`)와
 *   모바일 하단 탭바(`.bottomnav`) — StudentShell 의 MENU/TABS 가 의도적으로 그렇게 붙인다.
 *   그런데 querySelector 는 DOM 순서상 앞선 **데스크톱 메뉴를 항상 먼저** 준다. 그건 ≤768px 에서
 *   `display:none` 이라 getBoundingClientRect() 가 전부 0이고, 결과적으로 링이 대상 위가 아니라
 *   화면 좌상단에 12×12 점으로 찍혔다 — 메뉴를 짚는 1·4·9·11단계 전부가 그랬다.
 *   (클릭 감지는 closest() 라 탭바를 눌러도 진행은 됐다. 그래서 "안내가 안 보일 뿐 진도는 나가는"
 *    형태로 나타나 눈치채기 어려웠다.)
 *   크기가 0인 요소를 건너뛰면 화면 폭에 상관없이 "지금 보이는 쪽"이 선택된다.
 */
function visibleTarget(selector) {
  for (const el of document.querySelectorAll(selector)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return el;
  }
  return null;
}

// 상단 고정 네비(62px) 아래에 깔린 것도 "안 보이는" 것으로 친다.
const NAV_H = 70;

/** 뷰포트 밖(또는 고정 네비 아래)이라 사용자가 링을 볼 수 없는 상태인가. */
function isOffscreen(r) {
  return r.bottom < NAV_H || r.top > window.innerHeight - 8;
}

/** 두 사각형이 겹치는가(여유 8px 포함). */
function overlaps(a, b) {
  const pad = 8;
  return a.left < b.right + pad && a.right > b.left - pad && a.top < b.bottom + pad && a.bottom > b.top - pad;
}

export default function TutorialOverlay() {
  const tutorial = useTutorial();
  const ringRef = useRef(null);
  const bannerRef = useRef(null);

  // [위치 추적을 state 가 아니라 DOM 직접 쓰기로 한다 — 2026-08-13]
  //   이전에는 매 프레임 setRect(getBoundingClientRect()) 였다. rect 는 매번 새 객체라 값이 같아도
  //   리렌더가 돌았다 = 트래커가 켜진 내내 초당 60회 리렌더. 데스크톱에선 티가 안 났지만 모바일
  //   저사양 기기에서 QR 모달처럼 무거운 화면과 겹치면 눈에 띄게 버벅인다. 링은 화면에 그리는
  //   장식일 뿐 다른 렌더에 영향을 주지 않으므로 style 을 직접 쓰는 편이 정직하다.
  // [폴링을 유지하는 이유] 라우트 전환·모달 열림/닫힘마다 대상 DOM 이 통째로 바뀐다.
  //   MutationObserver 로 무엇이 바뀌었는지 추적하는 것보다 매 프레임 다시 찾는 쪽이 단순하다.
  useEffect(() => {
    if (!tutorial.active) return undefined;

    // [ref 를 루프 밖에서 한 번만 읽는다] 링·배너는 트래커가 켜져 있는 동안 마운트된 채로 유지되는
    // 같은 노드다. cleanup 에서 bannerRef.current 를 다시 읽으면 그때는 이미 바뀐 뒤일 수 있다.
    const ring = ringRef.current;
    const banner = bannerRef.current;

    let raf;
    let scrolledEl = null; // 이 단계에서 이미 화면 안으로 끌어온 요소
    let avoided = false; // 배너가 이미 위로 피했는가

    const tick = () => {
      const el =
        visibleTarget(`[data-tutorial="${tutorial.step}"]`) ??
        visibleTarget(`[data-tutorial-pre="${tutorial.step}"]`);
      const r = el ? el.getBoundingClientRect() : null;

      if (ring) {
        ring.hidden = !r;
        if (r) {
          ring.style.top = `${r.top - 6}px`;
          ring.style.left = `${r.left - 6}px`;
          ring.style.width = `${r.width + 12}px`;
          ring.style.height = `${r.height + 12}px`;
        }
      }

      // [목표가 화면 밖이면 한 번만 끌어온다 — 모바일에서 특히 중요]
      //   링은 position:fixed 라 뷰포트 밖의 대상을 그리면 그냥 안 보인다("빛나는 게 없다").
      //   좁은 화면에서는 목표 버튼이 접힌 스크롤 아래에 있는 일이 흔하다(참여 팝업의 CTA,
      //   QR 센터의 입·퇴장 버튼, 만족도 평가 폼).
      //   요소당 딱 한 번만 스크롤한다 — 사용자가 다시 스크롤해 치워도 따라가며 싸우지 않는다.
      if (el && r && el !== scrolledEl && isOffscreen(r)) {
        scrolledEl = el;
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }

      // [배너가 목표를 덮으면 위로 피한다]
      //   모바일 배너는 화면 하단 가로 전체를 쓰는 시트라, 목표가 화면 아래쪽에 있으면 링 자체가
      //   배너 밑에 깔린다(둘 다 z-index 300이고 배너가 DOM 뒤라 위에 그려진다).
      //   한 단계 안에서는 되돌리지 않는다 — 피했다가 내려오면 그 자리에서 또 겹쳐 깜빡인다.
      //   단계가 바뀌면 cleanup 이 .avoid 를 떼므로 매 단계 다시 판단한다.
      if (r && banner && !avoided && overlaps(r, banner.getBoundingClientRect())) {
        avoided = true;
        banner.classList.add('avoid');
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      banner?.classList.remove('avoid');
    };
  }, [tutorial.active, tutorial.step]);

  // [전역 클릭 감시] data-tutorial="N"(현재 단계)이 붙은 요소나 그 자손을 클릭하면 다음 단계로.
  // manual 단계(설명만, 클릭 대상 없음)는 감시하지 않는다 — 배너 자체의 "다음"/"완료" 버튼이 넘긴다.
  // [여기는 querySelector 문제가 없다] closest() 는 "눌린 요소의 조상 중에 있는가"를 보므로
  // 데스크톱 메뉴든 모바일 탭바든 실제로 눌린 쪽이 맞으면 통과한다.
  useEffect(() => {
    if (!tutorial.active || tutorial.stepConfig?.manual) return undefined;
    const onClick = (e) => {
      if (e.target?.closest?.(`[data-tutorial="${tutorial.step}"]`)) tutorial.advance();
    };
    // capture 단계에서 관찰만 한다 — stopPropagation을 하지 않으므로 실제 클릭 핸들러는 그대로 실행된다.
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [tutorial.active, tutorial.step, tutorial.stepConfig, tutorial.advance]);

  if (!tutorial.active) return null;

  return createPortal(
    <>
      {/* 위치·표시 여부는 위 rAF 루프가 직접 쓴다. 처음에는 감춰둔 채로 마운트한다. */}
      <div className="tut-ring" ref={ringRef} hidden aria-hidden="true" />
      <div className="tut-banner" ref={bannerRef} role="status">
        <div className="tut-head">
          <span className="tut-step">
            {tutorial.step}/{TUTORIAL_STEPS.length}
          </span>
          <button type="button" className="tut-close" onClick={tutorial.stop} aria-label="튜토리얼 종료">
            ×
          </button>
        </div>
        <div className="tut-text">{tutorial.stepConfig?.text}</div>
        {tutorial.stepConfig?.manual && (
          <button type="button" className="tut-next" onClick={tutorial.advance}>
            {tutorial.stepConfig?.isLast ? '완료' : '다음'}
          </button>
        )}
      </div>
    </>,
    document.body
  );
}
