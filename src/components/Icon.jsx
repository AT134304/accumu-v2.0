// Accumu v2 — duotone SVG 아이콘 (Accumu_prototype.html 470~509줄 스프라이트 재사용)
//
// [이모지 금지] CLAUDE.md 8장. 아이콘은 전부 이 파일의 duotone SVG를 쓴다.
// [스프라이트 대신 레지스트리인 이유] 프로토타입은 <use href="#ic-x">로 참조하는데,
//   그러려면 스프라이트 <svg>가 DOM에 먼저 마운트돼 있어야 한다는 순서 의존이 생긴다.
//   컴포넌트 레지스트리는 어디서 렌더하든 동작하고 트리 셰이킹도 자연스럽다. 경로 데이터는 원본 그대로다.
//
// 색은 fill:currentColor(.isvg)라 부모 color 또는 color prop으로 제어한다.
// 내부의 fill="#fff"는 duotone 하이라이트라 의도적으로 리터럴 흰색을 유지한다.

const ICONS = {
  // brand mark: 누적되는 막대 (단색 블루 톤 변화) — 유일하게 자체 색을 가진 아이콘
  'ic-logo': {
    viewBox: '0 0 32 30',
    content: (
      <>
        <rect x="2" y="19" width="5.4" height="9" rx="2.1" fill="#BCD0FF" />
        <rect x="9" y="14" width="5.4" height="14" rx="2.1" fill="#7098EE" />
        <rect x="16" y="9" width="5.4" height="19" rx="2.1" fill="#3463DA" />
        <rect x="23" y="3" width="5.4" height="25" rx="2.1" fill="#16213E" />
      </>
    ),
  },

  // ----- 활동 유형 (CAT) -----
  'ic-book': {
    content: (
      <>
        <path opacity=".34" d="M4 4.5h7.2V20H6.2A2.2 2.2 0 0 1 4 17.8V4.5z" />
        <path d="M12.8 4.5H20v13.3a2.2 2.2 0 0 1-2.2 2.2h-5V4.5z" />
      </>
    ),
  },
  'ic-users': {
    content: (
      <>
        <circle cx="9" cy="8" r="3.3" />
        <path d="M3.2 19.2a5.8 5.8 0 0 1 11.6 0v.6H3.2v-.6z" />
        <circle cx="16.8" cy="9" r="2.6" opacity=".34" />
        <path opacity=".34" d="M15.2 14.6a5.2 5.2 0 0 1 5.6 4.6v.6h-4.2v-.6c0-1.7-.5-3.3-1.4-4.6z" />
      </>
    ),
  },
  'ic-trophy': {
    content: (
      <>
        <path d="M7 4h10v4.2a5 5 0 0 1-10 0V4z" />
        <path opacity=".34" d="M10.4 12.4h3.2v3.4h-3.2zM8 17.8h8V20H8z" />
        <path
          opacity=".34"
          d="M5 5.2H3.2V7A3.2 3.2 0 0 0 7 10.1V8a1.4 1.4 0 0 1-2-1.3V5.2zM19 5.2h1.8V7A3.2 3.2 0 0 1 17 10.1V8a1.4 1.4 0 0 0 2-1.3V5.2z"
        />
      </>
    ),
  },
  'ic-grid': {
    content: (
      <>
        <rect x="4" y="4" width="7" height="7" rx="1.7" />
        <rect x="13" y="4" width="7" height="7" rx="1.7" opacity=".34" />
        <rect x="4" y="13" width="7" height="7" rx="1.7" opacity=".34" />
        <rect x="13" y="13" width="7" height="7" rx="1.7" />
      </>
    ),
  },
  'ic-building': {
    content: (
      <>
        <path opacity=".34" d="M3 9.5h7v10.5H3z" />
        <path d="M10 4h11v16h-11z" />
        <rect x="13" y="7" width="2" height="2" rx=".5" fill="#fff" opacity=".55" />
        <rect x="16.7" y="7" width="2" height="2" rx=".5" fill="#fff" opacity=".55" />
        <rect x="13" y="11" width="2" height="2" rx=".5" fill="#fff" opacity=".55" />
        <rect x="16.7" y="11" width="2" height="2" rx=".5" fill="#fff" opacity=".55" />
      </>
    ),
  },
  'ic-heart': {
    content: (
      <>
        <path d="M12 20.5S3.3 14.8 3.3 8.9A4.4 4.4 0 0 1 12 6.4 4.4 4.4 0 0 1 20.7 8.9C20.7 14.8 12 20.5 12 20.5z" />
        <path opacity=".34" d="M12 6.4A4.4 4.4 0 0 0 3.3 8.9c0 2.4 1.4 4.6 3.2 6.5L12 6.4z" />
      </>
    ),
  },
  'ic-rocket': {
    content: (
      <>
        <path d="M12 2.2c3.6 2.1 5.2 5.6 5.2 9.2l-2.6 2.6H9.4L6.8 11.4c0-3.6 1.6-7.1 5.2-9.2z" />
        <circle cx="12" cy="9" r="1.7" fill="#fff" opacity=".9" />
        <path opacity=".34" d="M9 15.4 7.4 20.5l3.2-1.7M15 15.4l1.6 5.1-3.2-1.7" />
      </>
    ),
  },
  'ic-globe': {
    content: (
      <>
        <circle cx="12" cy="12" r="9" />
        <g fill="none" stroke="#fff" strokeWidth="1.4" opacity=".8">
          <ellipse cx="12" cy="12" rx="4" ry="9" />
          <path d="M3.4 9.5h17.2M3.4 14.5h17.2" />
        </g>
      </>
    ),
  },

  // ----- 기능 / 네비 -----
  'ic-target': {
    content: (
      <>
        <circle cx="12" cy="12" r="9" opacity=".3" />
        <circle cx="12" cy="12" r="5" />
        <circle cx="12" cy="12" r="1.8" fill="#fff" opacity=".95" />
      </>
    ),
  },
  'ic-coin': {
    content: (
      <>
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="6.2" fill="none" stroke="#fff" strokeWidth="1.4" opacity=".55" />
        <text
          x="12"
          y="15.6"
          textAnchor="middle"
          fontSize="9"
          fontWeight="800"
          fill="#fff"
          fontFamily="Pretendard,sans-serif"
        >
          P
        </text>
      </>
    ),
  },
  'ic-folder': {
    content: (
      <>
        <path opacity=".34" d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v2H3V7z" />
        <path d="M3 10.2h18V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7.8z" />
      </>
    ),
  },
  'ic-home': {
    content: (
      <>
        <path opacity=".34" d="M3.5 11 12 3.8 20.5 11V20a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-9z" />
        <path d="M9 21v-6h6v6z" />
      </>
    ),
  },
  'ic-compass': {
    content: (
      <>
        <circle cx="12" cy="12" r="9" opacity=".3" />
        <path d="m16 8-2.3 6L7.8 16l2.3-6L16 8z" />
        <circle cx="12" cy="12" r="1.3" fill="#fff" opacity=".95" />
      </>
    ),
  },
  'ic-user': {
    content: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path opacity=".34" d="M4 21a8 8 0 0 1 16 0v.5H4V21z" />
      </>
    ),
  },

  // ----- 유틸 -----
  'ic-calendar': {
    content: (
      <>
        <rect x="3.5" y="5" width="17" height="16" rx="2.6" opacity=".3" />
        <rect x="3.5" y="5" width="17" height="4.4" rx="2" />
        <rect x="7" y="2.6" width="2" height="4.2" rx="1" />
        <rect x="15" y="2.6" width="2" height="4.2" rx="1" />
      </>
    ),
  },
  'ic-clock': {
    content: (
      <>
        <circle cx="12" cy="12" r="9" opacity=".3" />
        <path
          d="M12 7v5l3.4 2"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    ),
  },
  'ic-tag': {
    content: (
      <>
        <path d="M4 4.5h7L20 13l-7 7-9-9V4.5z" />
        <circle cx="8.4" cy="8.4" r="1.7" fill="#fff" opacity=".9" />
      </>
    ),
  },
  'ic-bell': {
    content: (
      <>
        <path d="M12 3a6 6 0 0 0-6 6c0 3.8-1.3 5.3-1.9 6.1-.4.5 0 1.1.6 1.1h14.6c.6 0 1-.6.6-1.1-.6-.8-1.9-2.3-1.9-6.1a6 6 0 0 0-6-6z" />
        <path opacity=".34" d="M9.5 19.2a2.5 2.5 0 0 0 5 0z" />
      </>
    ),
  },
  'ic-close': {
    content: (
      <path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    ),
  },
  // 프로토타입 스프라이트 499줄 — 프로그램 선택 화면 검색 입력
  'ic-search': {
    content: (
      <>
        <circle cx="10.5" cy="10.5" r="6.4" fill="none" stroke="currentColor" strokeWidth="2.2" />
        <path d="m15.4 15.4 5.1 5.1" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      </>
    ),
  },
  // 프로토타입 500줄 — 정렬 드롭다운 (인기순/최신순/포인트순)
  'ic-sort': {
    content: (
      <>
        <path
          d="M7 4.5v15M7 19.5l-3-3M7 4.5l3 3"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          opacity=".4"
          d="M17 19.5v-15M17 4.5l3 3M17 19.5l-3-3"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    ),
  },
  // 프로토타입 503줄 — "학교 내 활동" 그룹 헤더
  'ic-school': {
    content: (
      <>
        <path d="M12 3 22 8l-10 5L2 8l10-5z" />
        <path opacity=".34" d="M6 11.2v4.4c0 1.5 2.7 2.9 6 2.9s6-1.4 6-2.9v-4.4l-6 3-6-3z" />
      </>
    ),
  },
  // 프로토타입 스프라이트 501줄 — QR 코드 (마이페이지 진입 버튼 / 관리자 스캔 메뉴)
  'ic-qr': {
    content: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.6" />
        <rect x="14" y="3" width="7" height="7" rx="1.6" opacity=".34" />
        <rect x="3" y="14" width="7" height="7" rx="1.6" opacity=".34" />
        <rect x="14" y="14" width="3" height="3" />
        <rect x="18.2" y="14" width="2.8" height="3" />
        <rect x="14" y="18.2" width="3" height="2.8" />
        <rect x="18.2" y="18.2" width="2.8" height="2.8" opacity=".5" />
      </>
    ),
  },
  // 관리자 스캔 화면 — 카메라. (신규: 프로토타입에 스캐너 화면이 없어 대응 심볼이 없다)
  'ic-camera': {
    content: (
      <>
        <path opacity=".34" d="M3 8.6A2.6 2.6 0 0 1 5.6 6h1.8l1.3-2.2h5.6L15.6 6h2.8A2.6 2.6 0 0 1 21 8.6v8.8A2.6 2.6 0 0 1 18.4 20H5.6A2.6 2.6 0 0 1 3 17.4V8.6z" />
        <circle cx="12" cy="13" r="4" />
        <circle cx="12" cy="13" r="1.8" fill="#fff" opacity=".9" />
      </>
    ),
  },
  // 관리자 스캔 화면 — 거부/기술 오류 안내
  'ic-alert': {
    content: (
      <>
        <circle cx="12" cy="12" r="9" opacity=".34" />
        <rect x="10.9" y="6.6" width="2.2" height="7.4" rx="1.1" />
        <circle cx="12" cy="16.8" r="1.4" />
      </>
    ),
  },
  // 재발급 / 다시 시도
  'ic-refresh': {
    content: (
      <>
        <path
          d="M20 12a8 8 0 1 1-2.4-5.7"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.1"
          strokeLinecap="round"
        />
        <path d="M20.4 3.6v5.2h-5.2z" />
      </>
    ),
  },
  // 관리자 셸 — 로그아웃
  'ic-logout': {
    content: (
      <>
        <path opacity=".34" d="M4 5.6A2.6 2.6 0 0 1 6.6 3h4.8v18H6.6A2.6 2.6 0 0 1 4 18.4V5.6z" />
        <path
          d="M14.4 8.4 18 12l-3.6 3.6M17.4 12H9.6"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.1"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    ),
  },
  // ----- 관리자 프로그램 관리 (docs/specs/admin-programs.md "D. 재사용 / 신규 자산") -----
  // 프로토타입에 관리자 화면이 없어 대응 심볼이 없다. 이모지 금지(CLAUDE.md 8장)이므로 duotone SVG로 신규 작성.
  // 새 프로그램 올리기
  'ic-plus': {
    content: (
      <>
        <circle cx="12" cy="12" r="9" opacity=".34" />
        <path
          d="M12 7.8v8.4M7.8 12h8.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
      </>
    ),
  },
  // 수정
  'ic-edit': {
    content: (
      <>
        <path opacity=".34" d="M3.6 16.1 14.3 5.4l4.3 4.3L7.9 20.4H3.6v-4.3z" />
        <path d="M15.7 4a1.6 1.6 0 0 1 2.3 0l2 2a1.6 1.6 0 0 1 0 2.3l-1.1 1.1-4.3-4.3L15.7 4z" />
      </>
    ),
  },
  // 올리기 (게시)
  'ic-eye': {
    content: (
      <>
        <path
          opacity=".34"
          d="M12 5.4c4.5 0 8 3.4 9.3 6a1.4 1.4 0 0 1 0 1.2c-1.3 2.6-4.8 6-9.3 6s-8-3.4-9.3-6a1.4 1.4 0 0 1 0-1.2c1.3-2.6 4.8-6 9.3-6z"
        />
        <circle cx="12" cy="12" r="3.3" />
      </>
    ),
  },
  // 내리기 (게시중단)
  'ic-eye-off': {
    content: (
      <>
        <path
          opacity=".34"
          d="M12 5.4c4.5 0 8 3.4 9.3 6a1.4 1.4 0 0 1 0 1.2c-1.3 2.6-4.8 6-9.3 6s-8-3.4-9.3-6a1.4 1.4 0 0 1 0-1.2c1.3-2.6 4.8-6 9.3-6z"
        />
        <circle cx="12" cy="12" r="3.3" />
        {/* 흰 배경 획 → 어떤 배경에서도 사선이 눈에서 분리돼 보인다 (다른 아이콘의 fill="#fff" 하이라이트와 같은 계열) */}
        <path d="M4.6 4 20 19.4" fill="none" stroke="#fff" strokeWidth="3.6" strokeLinecap="round" />
        <path d="M4.6 4 20 19.4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </>
    ),
  },

  // 프로토타입 스프라이트 ic-doc — 아카이브 "PDF로 저장" 버튼 (프로토타입 625줄 .pdfbtn)
  'ic-doc': {
    content: (
      <>
        <path opacity=".32" d="M6 3h7.5L19 8.5V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
        <path d="M13.5 3 19 8.5h-5.5V3z" />
        <rect x="8" y="12" width="8" height="1.8" rx=".9" />
        <rect x="8" y="15.5" width="6" height="1.8" rx=".9" />
      </>
    ),
  },

  // 프로토타입 1358줄 — 토스트 아이콘.
  // [이모지 금지] 프로토타입 toast()는 체크마크 이모지 문자를 넘겼지만 CLAUDE.md 8장 위반이라 duotone SVG로 대체한다.
  'ic-check': {
    content: (
      <path
        d="M5 12.5 10 17.5 19.5 7"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  },
};

/**
 * @param {string} name        ICONS 키 (예: 'ic-compass')
 * @param {number} size        정사각 크기(px). width/height로 개별 지정 가능.
 * @param {string} [color]     CSS color 값. 미지정 시 부모 color 상속(fill:currentColor).
 */
export default function Icon({ name, size = 24, width, height, color, className = '', style }) {
  const icon = ICONS[name];
  if (!icon) return null;

  return (
    <svg
      className={className ? `isvg ${className}` : 'isvg'}
      viewBox={icon.viewBox ?? '0 0 24 24'}
      width={width ?? size}
      height={height ?? size}
      style={color ? { color, ...style } : style}
      aria-hidden="true"
      focusable="false"
    >
      {icon.content}
    </svg>
  );
}
