// Accumu v2 — 완료 활동 목록 (표시 전용)
//
// [공유 컴포넌트] 학생 아카이브 + 관리자 담당 학생 아카이브가 같이 쓴다.
//   **누구의 기록인지 알지 못한다** — activities 배열만 받는다(docs/specs/student-archive-mypage.md B절).
//   차이는 prop 으로 표현한다(onSelect 유무 등). 컴포넌트를 복제하면 두 아카이브의 표현이 갈라진다.
//
// [정렬] 정렬은 여기서 하지 않는다. archiveService.sortActivities()(programs.date 내림차순 → exit_at 내림차순)가
//   이미 정렬한 배열을 받는다 — 두 화면이 같은 순서를 보장하려면 정렬의 소유자가 하나여야 한다.
//
// [방어적 렌더 — ADR 0005 결정 7-4] 게시중단된 프로그램은 학생이 select 할 수 없다.
//   그 행은 사라지지 않고 "게시가 중단된 프로그램" + exit_at 기준 날짜 + 회색 fallback 아이콘으로 뜬다.
//   대체 문구 생성은 archiveService.describeActivity() 한 곳이 소유한다.
import Icon from '../Icon';
import { StarsMini } from '../student/ReviewForm';
import { describeActivity } from '../../lib/archiveService';
import { TRACK } from '../../lib/taxonomy';
import { fmtDateTime, fmtTime } from '../../lib/date';
import '../../styles/Archive.css';

/**
 * @param {{
 *   activities: Array<object>,
 *   onSelect?: (activity: object) => void,  // 없으면 행이 클릭 불가(관리자 아카이브는 상세가 없다)
 *   emptyText?: React.ReactNode,
 *   showConfirmedAt?: boolean,              // 입장(entry_at)·퇴장(exit_at) 인증 시각 줄
 *   reviewByParticipationId?: Map,          // 학생 화면 전용 — 평가 줄(결정 D)
 *   amountByParticipationId?: Map           // 학생 화면 전용 — 지급 포인트(확정 L-1)
 * }} props
 *
 * [두 Map 은 관리자 아카이브에서 넘기지 않는다] 리뷰는 본인만 읽고(결정 E), 포인트는 관리자 아카이브에
 *   표시하지 않기로 확정돼 있다(admin-students 결정 D). prop 이 없으면 그 자리가 아예 렌더되지 않는다.
 */
export default function ActivityList({
  activities = [],
  onSelect,
  emptyText = '아직 완료한 활동이 없습니다.',
  showConfirmedAt = true,
  showTrack = false,
  reviewByParticipationId,
  amountByParticipationId,
}) {
  if (activities.length === 0) {
    return <div className="empty">{emptyText}</div>;
  }

  return (
    <ul className="arc-list">
      {activities.map((a) => (
        <li key={a.id}>
          <ActivityRow
            activity={a}
            onSelect={onSelect}
            showConfirmedAt={showConfirmedAt}
            showTrack={showTrack}
            review={reviewByParticipationId?.get(a.id) ?? null}
            showReview={Boolean(reviewByParticipationId)}
            amount={amountByParticipationId?.get(a.id) ?? null}
          />
        </li>
      ))}
    </ul>
  );
}

function ActivityRow({ activity, onSelect, showConfirmedAt, showTrack, review, showReview, amount }) {
  const d = describeActivity(activity);
  // 진로 계열 — 관리자 상세는 활동 행에 계열을 함께 보여준다(admin-students B-5). 학생 화면은 상세 모달이
  // 그 자리를 이미 갖고 있어 기본은 꺼둔다. 프로그램을 못 읽은 건은 계열도 알 수 없어 자동으로 빠진다.
  const track = showTrack && d.careerTrack ? TRACK[d.careerTrack]?.name : null;
  // 주최는 있으면 넣는다 — 관리자 아카이브 메타(`그룹 · 유형 · 주최 · 날짜`)와 같은 줄을 공유한다.
  const meta = [d.catLabel, d.org, d.dateLabel].filter(Boolean).join(' · ');
  const clickable = typeof onSelect === 'function';

  const body = (
    <>
      {/* [대표 사진 — ADR 0022] 있으면 사진, 없으면 지금까지처럼 카테고리 아이콘.
          <img> 는 phrasing content 라 이 행이 <button> 이 돼도 유효하다(아래 span 주석의 "블록 요소를
          넣지 않는다"는 HTML 콘텐츠 모델 이야기이고 img 는 거기 걸리지 않는다). */}
      <span className="ic" style={{ background: d.cat.soft }}>
        {d.imageUrl ? (
          <img className="ic-photo" src={d.imageUrl} alt="" loading="lazy" />
        ) : (
          <Icon name={d.cat.icon} size={22} color={d.cat.color} />
        )}
      </span>
      {/* 행 전체가 <button> 이 될 수 있어 내부는 전부 span 이다(버튼 안에 블록 요소를 넣지 않는다).
          줄바꿈은 Archive.css 가 display:block 으로 만든다. */}
      <span className="info">
        <span className="t">{d.title}</span>
        <span className="m">{meta}</span>
        {/* QR 입·퇴장 인증 시각 — 아카이브에 뜨는 활동이 전부 2회 인증(원칙 5)을 통과했다는 사실이
            여기서 보인다. entry_at은 participations 조회에 이미 포함돼 있던 값이라(archiveService
            PARTICIPATION_FIELDS) 새 조회 없이 시각만 나란히 붙인다. */}
        {showConfirmedAt && activity.exit_at && (
          <span className="m confirm">
            {activity.entry_at && `입장 ${fmtTime(activity.entry_at)} · `}
            퇴장 {fmtDateTime(activity.exit_at)}
          </span>
        )}
        {track && <span className="arc-track">{track}</span>}
        {/* 평가 줄 (결정 D) — 별 미니 + 상태 문구. 건너뛴 활동은 여기서 "눌러서 남기기"로 되돌아온다.
            [원칙 1] 다른 학생의 별점·평균·리뷰 수를 함께 그리지 않는다(정책상 읽을 수도 없다). */}
        {showReview && (
          <span className="revline no-print">
            {review ? (
              <>
                <StarsMini rating={review.rating} />
                <span className="rt">평가 완료</span>
              </>
            ) : (
              <span className="rt none">평가 미작성 · 눌러서 남기기</span>
            )}
          </span>
        )}
      </span>
      {/* 지급 포인트 (확정 L-1) — 값의 소스는 point_transactions.amount(지급 시점 스냅샷)다.
          programs.points 로 대신하면 관리자가 프로그램 포인트를 수정한 순간 이미 지급된 금액과 어긋난다
          (ADR 0005 결정 3-6). 원장을 못 읽었으면 amount 가 null 이라 이 자리가 조용히 비고, 행은 그대로 뜬다.
          [원칙 4] .no-print — 입시 제출 문서에 남을 것은 활동 기록이지 포인트가 아니다. */}
      {amount != null && <span className="arc-pt no-print">+{Number(amount).toLocaleString()}P</span>}
      {clickable && <span className="chev" aria-hidden="true" />}
    </>
  );

  const className = d.known ? 'arc-row' : 'arc-row unknown';

  return clickable ? (
    <button type="button" className={className} onClick={() => onSelect(activity)}>
      {body}
    </button>
  ) : (
    <div className={className}>{body}</div>
  );
}
