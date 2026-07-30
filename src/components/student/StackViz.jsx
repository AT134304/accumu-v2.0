// Accumu v2 — 마일스톤 스택 시각화 (Accumu_prototype.html buildStack() 852줄)
//
// [실데이터 연결 — 확정 B-1 / ADR 0005 결정 5] (student-home 확정 G 해소)
//   소스는 내 `participations` 중 status === 'completed' 인 행이다. completed 는 QR 퇴장 인증으로만 생긴다.
//   - 월 버킷 기준은 **programs.date**(활동이 일어난 달)이지 exit_at 이 아니다. 마일스톤은 "언제 활동했는가"이고,
//     프로그램 상세와 같은 날짜 축을 써야 화면끼리 어긋나지 않는다.
//   - 월 캡션은 항상 실제 오늘 기준으로 계산한다(하드코딩 금지). 프로토타입의 ['3월'..'이번 달']은
//     TODAY_ISO='2026-07-02' 고정 전제의 산물이라 쓰지 않는다.
//   - 색: 교내 = brand blue / 교외 = indigo. **amber 금지** — amber는 포인트 색이라
//     "포인트가 쌓이는 그래프"로 읽히면 절대 원칙 4에 어긋난다.
//   - [원칙 1 가드] 숫자·레벨·게이지·"N개 달성" 라벨·학생 간 비교 표시를 넣지 않는다. 블록이 쌓이는 것까지만.
//   - [알려진 틈] 게시중단된 프로그램은 학생이 programs 행을 읽을 수 없어 월/카테고리를 결정할 수 없다.
//     그 활동은 블록으로 그리지 않는다(빈칸). 화면이 죽지 않는 것이 우선이다 (ADR 0005 결정 7-4).
import { catOf } from '../../lib/taxonomy';
import { monthKey, recentMonths } from '../../lib/date';

const COLS = 5; // 기둥(월) 수
const BLOCKS = 4; // 기둥당 블록 수 — 초과분은 그리지 않는다(숫자를 노출하지 않기 위해 "+N"도 없다)

/**
 * @param {Array<{program: {category?: string, date?: string}|null}>} completed
 *        완료된 참여 목록. 미전달(홈 로딩 중/조회 실패)이면 빈 상태 레이아웃 그대로다.
 */
export default function StackViz({ completed = [] }) {
  const months = recentMonths(COLS);

  // 월 키 -> 해당 월의 그룹('교내'|'교외') 목록. 날짜순으로 아래에서 위로 쌓는다.
  const buckets = new Map(months.map((m) => [m.key, []]));
  for (const row of completed) {
    const date = row?.program?.date;
    if (!date) continue; // 프로그램 정보를 못 찾은 완료 건 — 방어적으로 건너뛴다
    const bucket = buckets.get(monthKey(date));
    if (!bucket) continue; // 최근 5개월 밖
    bucket.push({ date, group: catOf(row.program.category).group });
  }
  for (const list of buckets.values()) list.sort((a, b) => String(a.date).localeCompare(String(b.date)));

  return (
    <div className="stackviz" role="img" aria-label="최근 5개월 활동 마일스톤">
      {months.map((m, ci) => {
        const filled = buckets.get(m.key) ?? [];
        return (
          <div className="col" key={m.key}>
            {Array.from({ length: BLOCKS }, (_, bi) => {
              const item = filled[bi];
              // 교외만 indigo(.i). 교내와 미분류는 brand blue 기본. amber(.a)는 쓰지 않는다.
              const cls = item ? (item.group === '교외' ? 'blk fill i' : 'blk fill') : 'blk';
              return (
                <div
                  className={cls}
                  key={bi}
                  // 아래->위로 순차 등장 (프로토타입 animation-delay 계산식 그대로)
                  style={{ animationDelay: `${ci * 0.08 + bi * 0.05}s` }}
                />
              );
            })}
            <div className="cap" aria-hidden="true">{m.caption}</div>
          </div>
        );
      })}
    </div>
  );
}
