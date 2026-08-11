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
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { TUTORIAL_STEPS, useTutorial } from '../../context/TutorialContext';
import '../../styles/Tutorial.css';

export default function TutorialOverlay() {
  const tutorial = useTutorial();
  const [rect, setRect] = useState(null);

  // [폴링으로 위치를 쫓는다] 라우트 전환·모달 열림/닫힘마다 대상 DOM이 통째로 바뀌므로
  // MutationObserver로 정확히 무엇이 바뀌었는지 추적하는 것보다 매 프레임 다시 찾는 쪽이 이
  // 규모(트래커가 켜져 있는 짧은 동안만)에서 더 단순하고 실수할 여지가 적다.
  useEffect(() => {
    if (!tutorial.active) {
      setRect(null);
      return undefined;
    }
    let raf;
    const tick = () => {
      // 진짜 진행 목표가 있으면 그쪽을 우선한다 — 없을 때만(아직 그 화면/모달에 도달하지 않았을 때)
      // "하이라이트 전용" 중간 버튼으로 대체한다.
      const el =
        document.querySelector(`[data-tutorial="${tutorial.step}"]`) ??
        document.querySelector(`[data-tutorial-pre="${tutorial.step}"]`);
      setRect(el ? el.getBoundingClientRect() : null);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [tutorial.active, tutorial.step]);

  // [전역 클릭 감시] data-tutorial="N"(현재 단계)이 붙은 요소나 그 자손을 클릭하면 다음 단계로.
  // manual 단계(설명만, 클릭 대상 없음)는 감시하지 않는다 — 배너 자체의 "다음"/"완료" 버튼이 넘긴다.
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
      {rect && (
        <div
          className="tut-ring"
          style={{ top: rect.top - 6, left: rect.left - 6, width: rect.width + 12, height: rect.height + 12 }}
          aria-hidden="true"
        />
      )}
      <div className="tut-banner" role="status">
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
