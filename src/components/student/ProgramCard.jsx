// Accumu v2 — 프로그램 카드 (Accumu_prototype.html pcardHTML() 815줄 재현)
// 표시 필드: category(그룹·표시명 태그) / title / org / date / time / points / status / isMatched
//           + participation(신청 상태) / past(날짜 지남) / applicantCount(신청자 수, ADR 0016)
//           / waitlistPosition(내 대기 순번, ADR 0018)
// [원칙 가드] popularity는 화면에 절대 표시하지 않는다 — 프로그램 선택 화면에서 "인기순" 정렬의 입력으로만
//   쓰이며, 순위 라벨은 만들지 않는다 (CLAUDE.md 2장 1번). 신청자 수·내 대기 순번은 다른 학생과 겨루는
//   순위가 아니라 단순 카운트/내 상황이라 ADR 0016·0018로 예외를 열었다(케빈 요청).
import { useState } from 'react';
import Icon from '../Icon';
import { catOf, statusOf, TRACK } from '../../lib/taxonomy';
import { fmtDateRange } from '../../lib/date';
import { useTutorial } from '../../context/TutorialContext';

/**
 * @param {{id: string, status: string}|undefined} participation
 *   본인의 참여 행(있으면). status는 applied/waitlisted/entered/completed 중 하나 — 존재 자체가
 *   "신청됨"의 증거다(ADR 0004 구현 가이드 4번).
 * @param {number|null} applicantCount 이 프로그램의 신청자 수(applied+entered+completed). ADR 0016.
 *   [기본값이 0이 아니라 null인 이유] 홈(StudentHomePage)은 이 값을 아예 넘기지 않는다 — 0을 기본값으로
 *   두면 실제로는 신청자가 있는데도 "조회 안 함"과 "정말 0명"을 구분 못 해 홈 카드마다 거짓으로
 *   "0명 신청"이 뜬다. null이면 그 줄 자체를 렌더하지 않는다(모르는 것을 안다고 말하지 않는다).
 * @param {number|null} waitlistPosition 내가 대기 중이면 몇 번째인지(1부터). ADR 0018.
 */
export default function ProgramCard({
  program,
  onOpen,
  participation,
  past = false,
  applicantCount = null,
  waitlistPosition = null,
}) {
  const c = catOf(program.category);
  const st = statusOf(program.status);
  // [진로 계열 — 케빈 요청 2026-08-14] category(무엇을 하는가)와 career_track(어느 계열인가)은
  // 완전히 별개 축인데(ADR 0014) 지금까지 카드에는 category 만 찍혔다. 계열을 보고 고르는 학생은
  // 카드를 하나하나 열어봐야 했다. TRACK 에 없는 키(데이터 이상)면 칩 자체를 렌더하지 않는다.
  const track = TRACK[program.career_track] ?? null;
  const tutorial = useTutorial();
  // [사진이 깨졌을 때 아이콘으로 되돌린다 — ADR 0022] image_url 은 스토리지 오브젝트를 가리키는데
  // DB 행과 파일의 수명이 분리돼 있다(앱은 오브젝트를 지우지 않지만 대시보드에서는 지울 수 있다).
  // 그때 alt="" 인 깨진 이미지가 카드마다 뜨는 대신, 사진이 없던 시절의 표시로 조용히 돌아간다.
  const [photoFailed, setPhotoFailed] = useState(false);
  const photo = program.image_url && !photoFailed ? program.image_url : null;

  const status = participation?.status;
  const joined = Boolean(status);
  // 정원이 찼다는 사실은 더 이상 신청을 막지 않는다(ADR 0016) — 눌러도 대기로 등록될 뿐이라
  // 라벨만 "대기 신청"으로 바꾸고 버튼은 계속 눌린다. 예전의 '마감'(사후 거부 표시)은 사라졌다.
  // applicantCount가 null(미조회)이면 정원 찬 여부를 판단할 수 없으니 capacityFull은 항상 false다.
  const capacityFull = !joined && applicantCount != null && program.capacity != null && applicantCount >= program.capacity;

  // 라벨 우선순위: 대기중 > 신청됨(입장/퇴장 포함) > 종료됨 > 대기 신청 > status 라벨.
  // past는 확정 H-1(지난 날짜 신청 차단)을 카드 버튼에도 반영한 것이다. 프로토타입은 날짜를 보지 않아
  // 과거 프로그램에도 '참여' 버튼이 활성으로 남는 버그가 있다 — 재현하지 않는다.
  // 카드 본체 클릭은 계속 팝업을 열 수 있다(지난 활동도 상세는 볼 수 있어야 한다). 버튼만 잠근다.
  // [대기 순번 — ADR 0018] "대기중"만으로는 얼마나 기다려야 할지 감이 안 온다. waitlistPosition이
  // 있으면 "대기 3번째"로 더 구체적으로 보여준다(원칙 1 — 다른 학생과 겨루는 순위가 아니라 내 상황).
  const label =
    status === 'waitlisted'
      ? waitlistPosition != null
        ? `대기 ${waitlistPosition}번째`
        : '대기중'
      : joined
        ? '신청됨'
        : past
          ? '종료됨'
          : capacityFull
            ? '대기 신청'
            : st.join
              ? '참여'
              : st.label;
  const disabled = joined || past || !st.join;

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
      // [ADR 0021 — 버그 수정] 하이라이트 전용(data-tutorial-pre) — 이 카드를 진행 트리거로 삼으면
      // 카드를 여는 순간(아직 신청도 안 했는데) 3단계로 넘어가 버린다. 실제 진행은 JoinModal의
      // "참석 신청하기" 버튼(data-tutorial="2")이 맡는다.
      data-tutorial-pre={program.is_tutorial && tutorial.isStep(2) ? 2 : undefined}
    >
      {/* [썸네일 자리 — ADR 0022] 사진이 있으면 사진, 없으면 지금까지처럼 카테고리 아이콘.
          그라데이션 배경은 둘 다에서 유지된다(사진이 로드되기 전 빈 회색 대신 이 색이 보인다). */}
      <div className={photo ? 'thumb has-photo' : 'thumb'} style={{ background: `linear-gradient(135deg,${c.soft},#fff)` }}>
        {photo ? (
          // alt="" — 바로 아래 제목·주최가 같은 정보를 글로 주는 장식 이미지다(중복 낭독 방지).
          <img className="thumb-photo" src={photo} alt="" loading="lazy" onError={() => setPhotoFailed(true)} />
        ) : (
          <Icon name={c.icon} size={40} color={c.color} />
        )}
        {/* group(교내/교외)이 사라져 유형 이름 하나다 — ADR 0014.
            배경은 유형색(CAT[].deep) — 사진이 들어와도 유형이 먼저 읽히게 한다(2026-08-13). */}
        <span className="tag" style={{ background: c.deep }}>
          {c.name}
        </span>
        {/* 계열 매칭 배지 — 개인화 표시일 뿐 보상/랭킹 요소가 아니다 (확정 E) */}
        {program.isMatched && (
          <span className="matchbadge">
            <Icon name="ic-target" size={12} />
            내 관심 계열
          </span>
        )}
        {/* [진로 계열 칩 — 2026-08-14] 왼쪽 **아래** 구석이다. 위 줄은 이미 유형(좌)과 매칭 배지(우)가
            쓰고 있어서, 236px 카드에서 셋을 한 줄에 넣으면 서로 겹친다.
            [흰 알약 + 색 점] 유형 칩처럼 계열색을 배경으로 깔지 않는다. 두 개의 진한 알약이 나란히
            있으면 어느 쪽이 무슨 축인지 흐려지고, 무엇보다 TRACK 색 중에는 흰 글씨 대비가
            모자란 값이 있다(sci #0EA5E9). 흰 배경은 사진 위에서도 항상 읽히고, 색은 점이 나른다. */}
        {track && (
          <span className="trackchip">
            <i style={{ background: track.color }} />
            {track.name}
          </span>
        )}
      </div>

      <div className="body">
        <h4>{program.title}</h4>
        <div className="meta">
          <Icon name="ic-tag" size={13} />
          {program.org}
        </div>
        <div className="meta">
          <Icon name="ic-calendar" size={13} />
          {/* date는 프런트에서 "7월 16일 (목)"으로 포맷. 기간제(end_date 있음)는 범위로 찍힌다(fmtDateRange).
              time은 자유 텍스트라 파싱 없이 그대로 출력.
              [is_tutorial — ADR 0021] date 컬럼 값 자체가 의미 없는 자리표시자라 그대로 찍지 않는다. */}
          {program.is_tutorial ? '상시 진행' : fmtDateRange(program.date, program.end_date)} · {program.time}
        </div>
        {/* 신청자 수 — 케빈 요청(2026-08-10) "신청자 수를 보이게 해" (ADR 0016). 순위·비교가 아니라
            그 카드 하나의 사실이다. applicantCount가 null(홈 추천 카드 등, 아직 조회 안 함)이면
            줄 자체를 숨긴다 — "0명 신청"을 거짓으로 보여주지 않는다. */}
        {applicantCount != null && (
          <div className="meta">
            <Icon name="ic-users" size={13} />
            {applicantCount}명 신청
          </div>
        )}
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
