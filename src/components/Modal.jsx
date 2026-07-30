// Accumu v2 — 공용 모달 (Accumu_prototype.html .overlay/.modal 재현)
// 프로토타입은 display:none <-> .on 토글이지만, React에서는 열릴 때만 마운트하므로 항상 열린 상태로 렌더한다.
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';

// className: 모달 크기/여백을 화면별로 좁힐 때만 쓴다(예: 관리자 폼 모달의 넓은 폭 + 모바일 탭바 회피).
export default function Modal({ onClose, labelledBy, className = '', children }) {
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

  // [document.body 로 포털한다 — position:fixed 를 되살리기 위해]
  //   모달을 페이지 트리 안에 그대로 두면 `.screen`(animation: fade — 키프레임에 transform 이 있다)이
  //   fixed 자식의 기준(containing block)이 되어, .overlay 의 inset:0 이 뷰포트가 아니라 `.screen` 전체
  //   = 스크롤되는 문서 전체를 덮는다. 그러면 모달이 "보고 있는 화면 중앙"이 아니라 "문서 전체의 중앙"에
  //   떠서, 아래로 스크롤한 상태에서 카드를 누르면 팝업이 위쪽 어딘가에 열린다.
  //   body 로 빼내면 조상에 transform 이 없어 fixed 가 본래대로 뷰포트 기준이 된다.
  //   (애니메이션 타이밍이나 CSS 순서에 기대지 않는 확실한 방법이다.)
  return createPortal(
    <div
      className="overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={className ? `modal ${className}` : 'modal'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
      >
        <button type="button" className="mclose" onClick={onClose} aria-label="닫기">
          <Icon name="ic-close" size={18} />
        </button>
        {children}
      </div>
    </div>,
    document.body
  );
}
