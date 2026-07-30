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
import { describeActivity } from '../../lib/archiveService';
import { fmtDateTime } from '../../lib/date';
import '../../styles/Archive.css';

/**
 * @param {{
 *   activities: Array<object>,
 *   onSelect?: (activity: object) => void,  // 없으면 행이 클릭 불가(관리자 아카이브는 상세가 없다)
 *   emptyText?: React.ReactNode,
 *   showConfirmedAt?: boolean               // 참여 확인 일시(exit_at) 줄
 * }} props
 */
export default function ActivityList({
  activities = [],
  onSelect,
  emptyText = '아직 완료한 활동이 없습니다.',
  showConfirmedAt = true,
}) {
  if (activities.length === 0) {
    return <div className="empty">{emptyText}</div>;
  }

  return (
    <ul className="arc-list">
      {activities.map((a) => (
        <li key={a.id}>
          <ActivityRow activity={a} onSelect={onSelect} showConfirmedAt={showConfirmedAt} />
        </li>
      ))}
    </ul>
  );
}

function ActivityRow({ activity, onSelect, showConfirmedAt }) {
  const d = describeActivity(activity);
  // 주최는 있으면 넣는다 — 관리자 아카이브 메타(`그룹 · 유형 · 주최 · 날짜`)와 같은 줄을 공유한다.
  const meta = [d.catLabel, d.org, d.dateLabel].filter(Boolean).join(' · ');
  const clickable = typeof onSelect === 'function';

  const body = (
    <>
      <span className="ic" style={{ background: d.cat.soft }}>
        <Icon name={d.cat.icon} size={22} color={d.cat.color} />
      </span>
      {/* 행 전체가 <button> 이 될 수 있어 내부는 전부 span 이다(버튼 안에 블록 요소를 넣지 않는다).
          줄바꿈은 Archive.css 가 display:block 으로 만든다. */}
      <span className="info">
        <span className="t">{d.title}</span>
        <span className="m">{meta}</span>
        {/* QR 퇴장 인증 시각. 아카이브에 뜨는 활동이 전부 2회 인증을 통과했다는 사실이 여기서 보인다. */}
        {showConfirmedAt && activity.exit_at && (
          <span className="m confirm">참여 확인 · {fmtDateTime(activity.exit_at)}</span>
        )}
        {/* [자리 — 평가 줄] reviews 테이블이 생기면 여기에 별 미니 + "평가 완료"/"평가 미작성"이 들어간다
            (docs/specs/student-archive-mypage.md 결정 D). 학생 화면에서만 쓰므로 prop 으로 켠다. */}
      </span>
      {/* [자리 — 포인트]
          `<span className="pt">+{amount}P</span>` 한 줄이 여기 들어간다. 단, 값의 소스는 반드시
          point_transactions.amount(지급 시점 스냅샷)여야 한다 — programs.points 로 대신하면 관리자가
          프로그램 포인트를 수정한 순간 이미 지급된 금액과 어긋난다(ADR 0005 결정 3-6).
          그 테이블은 현재 select 정책이 0개라 학생 본인도 읽을 수 없어 이번 범위에서 제외했다.
          정책이 생기면 amountByParticipationId prop 을 추가해 이 자리에서만 렌더한다.
          [원칙 4] PDF 에는 포인트가 남지 않아야 하므로 그 요소에 .no-print 를 붙일 것. */}
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
