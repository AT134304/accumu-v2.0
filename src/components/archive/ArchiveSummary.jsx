// Accumu v2 — 아카이브 요약 블록 (활동 수 3칸 + 유형 분포 + 활동 기간)
//
// [공유 컴포넌트] 학생/관리자 아카이브가 같은 표현을 쓴다. 누구의 기록인지 알지 못한다.
//
// [결정 C — 막대 게이지 기각 / 확정 M-2 이후에도 이 블록은 텍스트다]
//   프로토타입의 .cc .bar 막대(width:N%)를 옮기지 않았다. 원칙 1: 게이지·레벨·"N개 달성"은 성취 연출이다.
//   사실 기술 텍스트로만 적는다: `총 5 · 교내 3 · 교외 2` / `방과후 2 · 봉사활동 2` / `2026년 3월 ~ 7월`.
//
//   [레이더와의 관계 — 지우지 말 것] 확정이 M-1(레이더 기각) -> M-2(추가)로 뒤집혀 TrackRadar 가 생겼지만,
//   이 텍스트 요약은 **그대로 유지한다.** 축이 다르고(여기는 활동 유형 CAT 8종, 레이더는 진로 계열 TRACK 5종)
//   무엇보다 그래프가 유일한 정보원이 되면 안 된다 — 스크린리더·저시력·인쇄 축소본에서 정보가 통째로 사라진다.
//
// [원칙 4] 3칸은 전부 활동 수다. 포인트 총액 칸을 추가하지 말 것 — 요약이 활동 수라는 것이 위계의 핵심이다.
// [원칙 1] 숫자 카운트업(프로토타입 animateNum)을 옮기지 않았다. 값은 그냥 렌더된다.
// [인쇄] 이 블록은 인쇄에 남는다. 600px 이하/인쇄에서 사라지는 StackViz 를 대신하므로 .arc-hero 안에 넣지 말 것.
import { summarizeActivities } from '../../lib/archiveService';
import '../../styles/Archive.css';

/**
 * @param {{activities: Array<object>}} props 완료 활동 목록(프로그램 결합본)
 */
export default function ArchiveSummary({ activities = [] }) {
  const s = summarizeActivities(activities);

  return (
    <div className="arc-panel">
      <div className="arc-totals">
        <div className="arc-tot hl">
          <div className="n">{s.total}</div>
          <div className="l">총 참여 활동</div>
        </div>
        <div className="arc-tot">
          <div className="n">{s.inCount}</div>
          <div className="l">교내 활동</div>
        </div>
        <div className="arc-tot">
          <div className="n">{s.exCount}</div>
          <div className="l">교외 활동</div>
        </div>
      </div>

      <div className="arc-facts">
        <div className="arc-factrow">
          <span className="k">유형</span>
          {s.byCat.length === 0 && s.unknown === 0 ? (
            <span className="arc-period">아직 집계할 활동이 없어요</span>
          ) : (
            <span className="arc-dist">
              {s.byCat.map((c) => (
                <span className="d" key={c.key}>
                  <i style={{ background: c.color }} />
                  {c.label} <b>{c.count}</b>
                </span>
              ))}
              {/* 프로그램 정보를 못 찾은 완료 건(게시중단 — ADR 0005 결정 7-4)도 조용히 빼지 않는다.
                  총합과 분포가 어긋나면 학생이 "기록이 사라졌다"고 읽는다. */}
              {s.unknown > 0 && (
                <span className="d none">
                  <i />
                  분류 없음 <b>{s.unknown}</b>
                </span>
              )}
            </span>
          )}
        </div>

        {s.periodLabel && (
          <div className="arc-factrow">
            <span className="k">활동 기간</span>
            <span className="arc-period">{s.periodLabel}</span>
          </div>
        )}
      </div>
    </div>
  );
}
