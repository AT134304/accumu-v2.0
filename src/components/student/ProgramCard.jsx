// Accumu v2 — 프로그램 카드 (Accumu_prototype.html pcardHTML() 815줄 재현)
// 표시 필드: category(그룹·표시명 태그) / title / org / date / time / points / status / isMatched
//           + joined(신청됨) / past(날짜 지남) — 버튼 라벨·비활성에만 쓴다.
// [원칙 가드] popularity는 화면에 절대 표시하지 않는다 — 프로그램 선택 화면에서 "인기순" 정렬의 입력으로만
//   쓰이며, 신청자 수·순위 라벨도 만들지 않는다 (CLAUDE.md 2장 1번).
import Icon from '../Icon';
import { catOf, statusOf } from '../../lib/taxonomy';
import { fmtDate } from '../../lib/date';

export default function ProgramCard({ program, onOpen, joined = false, past = false, full = false }) {
  const c = catOf(program.category);
  const st = statusOf(program.status);

  // 라벨 우선순위: 신청됨 > 종료됨 > 정원 마감 > status 라벨. (프로토타입의 '참여 완료'는 QR 퇴장 인증이 생긴 뒤 몫이라
  // 이번 스코프에 등장하지 않는다 — "신청됨" 판정은 participations 행의 존재 여부로만 한다. ADR 0004 구현 가이드 4번)
  // past는 확정 H-1(지난 날짜 신청 차단)을 카드 버튼에도 반영한 것이다. 프로토타입은 날짜를 보지 않아
  // 과거 프로그램에도 '참여' 버튼이 활성으로 남는 버그가 있다 — 재현하지 않는다.
  // 카드 본체 클릭은 계속 팝업을 열 수 있다(지난 활동도 상세는 볼 수 있어야 한다). 버튼만 잠근다.
  //
  // [full 은 조회로 알 수 없는 값이다] 이번 세션에서 신청을 눌러 DB에 거부당했을 때만 true 가 된다
  //   (ADR 0006 / 확정 K-1 사후 거부). joined 를 앞에 두는 이유는 결정 5-2와 같다 —
  //   이미 신청한 사람에게 "마감"은 거짓말이다.
  // [원칙 1 가드] 숫자를 붙이지 않는다. "남은 자리 N석"/"N/20명"/"마감 임박"/게이지 금지 — 데이터도 없다.
  const label = joined ? '신청됨' : past ? '종료됨' : full ? '마감' : st.join ? '참여' : st.label;
  const disabled = joined || past || full || !st.join;

  return (
    <div
      className="pcard"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="thumb" style={{ background: `linear-gradient(135deg,${c.soft},#fff)` }}>
        {/* group(교내/교외)이 사라져 유형 이름 하나다 — ADR 0014 */}
        <span className="tag">{c.name}</span>
        {/* 계열 매칭 배지 — 개인화 표시일 뿐 보상/랭킹 요소가 아니다 (확정 E) */}
        {program.isMatched && (
          <span className="matchbadge">
            <Icon name="ic-target" size={12} />
            내 관심 계열
          </span>
        )}
        <Icon name={c.icon} size={40} color={c.color} />
      </div>

      <div className="body">
        <h4>{program.title}</h4>
        <div className="meta">
          <Icon name="ic-tag" size={13} />
          {program.org}
        </div>
        <div className="meta">
          <Icon name="ic-calendar" size={13} />
          {/* date는 프런트에서 "7월 16일 (목)"으로 포맷. time은 자유 텍스트라 파싱 없이 그대로 출력. */}
          {fmtDate(program.date)} · {program.time}
        </div>
        <div className="foot">
          {/* 포인트 amber는 카드의 이 뱃지에서만 (절대 원칙 4) */}
          <div className="pt">
            +{program.points}
            <em>P</em>
          </div>
          {/* [disabled 대신 aria-disabled] disabled 버튼은 click 이벤트 자체가 발생하지 않아 부모 카드의
              onClick 도 타지 않는다 = 버튼 영역만 클릭이 죽는 구멍이 생긴다. 위 주석대로 "지난/신청한 활동도
              상세는 볼 수 있어야" 하므로, 잠그는 것은 '신청 동작'이지 '팝업 열기'가 아니다.
              신청 차단은 JoinModal 의 CTA(및 RLS)가 담당하고 여기서는 시각적 비활성 + 스크린리더 고지만 한다. */}
          <button
            type="button"
            className="join-btn"
            aria-disabled={disabled}
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
          >
            {label}
          </button>
        </div>
      </div>
    </div>
  );
}
