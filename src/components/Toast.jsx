// Accumu v2 — 공통 토스트 (Accumu_prototype.html #toast(430줄) + toast()(1351줄) 재현)
//
// [프로토타입과 다른 점 2가지]
//  1. [이모지 금지] 원본 toast(ic, msg)의 첫 인자는 체크마크 이모지 문자였다. CLAUDE.md 8장 위반이라
//     duotone SVG(ic-check)로 대체했다.
//  2. 원본은 항상 DOM에 있는 #toast를 .on 토글로 켜지만, React에서는 필요할 때만 마운트하고
//     등장 애니메이션을 CSS로 준다. 호출부가 key를 바꿔주면 같은 문구도 다시 뜬다.
//
// 모바일(≤768px)에서는 하단 탭바를 가리지 않도록 bottom:84px (프로토타입 445줄).
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';
import '../styles/Toast.css';

export default function Toast({ message, onDone, duration = 2600 }) {
  useEffect(() => {
    const t = setTimeout(onDone, duration);
    return () => clearTimeout(t);
  }, [onDone, duration]);

  // 셸/모달의 stacking context 영향을 받지 않도록 body에 포털로 띄운다.
  return createPortal(
    <div className="toast" role="status" aria-live="polite">
      <span className="tic">
        <Icon name="ic-check" size={17} />
      </span>
      {message}
    </div>,
    document.body
  );
}
