// Accumu v2 — 공용 모달 (Accumu_prototype.html .overlay/.modal 재현)
// 프로토타입은 display:none <-> .on 토글이지만, React에서는 열릴 때만 마운트하므로 항상 열린 상태로 렌더한다.
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// className: 모달 크기/여백을 화면별로 좁힐 때만 쓴다(예: 관리자 폼 모달의 넓은 폭 + 모바일 탭바 회피).
// closeAbove: 닫기 버튼을 카드 안 우상단이 아니라 카드 바깥 바로 위에 놓는다.
//   프로토타입에서 그 자리는 컬러 썸네일(.mthumb)이라 가릴 내용이 없었지만, 썸네일이 없는
//   알림/캘린더 팝업에서는 같은 자리에 "모두 읽음" 버튼과 다음 달 화살표가 있어 서로 가렸다.
//   기본값은 false — 기존 팝업들의 배치는 그대로 둔다.
export default function Modal({ onClose, labelledBy, className = '', closeAbove = false, children }) {
  // 포커스 트랩의 경계 — closeAbove 일 때는 바깥 "above" 닫기 버튼까지 포함해야 하므로 .mstack에,
  // 아니면 카드 자체(.modal)에 붙인다. 아래 두 번째 useEffect 하나가 이 ref로 경계를 정한다.
  const trapRef = useRef(null);

  // Esc로 닫기 (프로토타입에는 없지만 접근성 기본. 오버레이 클릭 닫기는 프로토타입 closeOverlay 동작 그대로)
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 열려 있는 동안 배경 스크롤을 잠근다. 없으면 모달 뒤 페이지가 같이 스크롤돼
  // "모달은 그대로인데 뒤가 움직이는" 어긋남이 생긴다.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // [초기 포커스 + Tab 트랩 + 복원 — 접근성 완성도 개선]
  //   연 순간 모달 안 첫 포커스 가능한 요소로 옮기고, Tab/Shift+Tab이 모달 밖(뒤 배경의 나브·카드 등)
  //   으로 새지 않게 마지막<->처음을 순환시킨다. 닫히면 모달을 열기 직전 포커스로 되돌린다 —
  //   안 그러면 키보드/스크린리더 사용자가 모달이 닫힌 뒤 어디에 있었는지 다시 찾아야 한다.
  useEffect(() => {
    const prevFocused = document.activeElement;
    const focusable = () =>
      trapRef.current ? Array.from(trapRef.current.querySelectorAll(FOCUSABLE_SELECTOR)) : [];

    const first = focusable()[0];
    (first ?? trapRef.current)?.focus();

    function onKeyDown(e) {
      if (e.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) return;
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      if (prevFocused instanceof HTMLElement) prevFocused.focus();
    };
  }, []);

  // [document.body 로 포털한다 — position:fixed 를 되살리기 위해]
  //   모달을 페이지 트리 안에 그대로 두면 `.screen`(animation: fade — 키프레임에 transform 이 있다)이
  //   fixed 자식의 기준(containing block)이 되어, .overlay 의 inset:0 이 뷰포트가 아니라 `.screen` 전체
  //   = 스크롤되는 문서 전체를 덮는다. 그러면 모달이 "보고 있는 화면 중앙"이 아니라 "문서 전체의 중앙"에
  //   떠서, 아래로 스크롤한 상태에서 카드를 누르면 팝업이 위쪽 어딘가에 열린다.
  //   body 로 빼내면 조상에 transform 이 없어 fixed 가 본래대로 뷰포트 기준이 된다.
  //   (애니메이션 타이밍이나 CSS 순서에 기대지 않는 확실한 방법이다.)
  // 바깥(빈 곳) 클릭으로 닫기. closeAbove 일 때는 카드를 감싸는 .mstack 도 같은 판정을 받는다 —
  // 버튼과 카드 사이 여백이 "안 닫히는 구멍"이 되지 않게.
  const closeOnSelf = (e) => {
    if (e.target === e.currentTarget) onClose();
  };

  // 트랩 경계는 "화면에 보이는 모달 전체"여야 한다 — closeAbove일 때 바깥 above 닫기 버튼도
  // Tab으로 오갈 수 있어야 하므로 그때는 .mstack(아래)에 ref를 붙이고, 여기(.modal)에는 안 붙인다.
  const card = (
    <div
      ref={closeAbove ? null : trapRef}
      className={className ? `modal ${className}` : 'modal'}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      tabIndex={-1}
    >
      {!closeAbove && (
        <button type="button" className="mclose" onClick={onClose} aria-label="닫기">
          <Icon name="ic-close" size={18} />
        </button>
      )}
      {children}
    </div>
  );

  return createPortal(
    <div className="overlay" onClick={closeOnSelf}>
      {closeAbove ? (
        <div className="mstack" ref={trapRef} tabIndex={-1} onClick={closeOnSelf}>
          <button type="button" className="mclose above" onClick={onClose} aria-label="닫기">
            <Icon name="ic-close" size={16} />
          </button>
          {card}
        </div>
      ) : (
        card
      )}
    </div>,
    document.body
  );
}
