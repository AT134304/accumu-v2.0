// Accumu v2 — 포인트 내역(원장) 목록 (docs/specs/student-archive-mypage.md B-2 4번 / 결정 H)
//
// [원칙 1 가드] 여기 있는 것은 "무슨 일이 언제 있었고 얼마인가"라는 사실 목록뿐이다.
//   분야별 획득 포인트 막대(프로토타입 .fieldpts)를 이식하지 않는다 — 결정 H 가 기각했다.
//   달성률·진척도·등급·랭킹·다른 학생 비교·카운트업 애니메이션도 없다.
// [원칙 4 가드] amber 는 적립 행의 금액 한 곳에만 쓴다. 목록의 나머지는 중립 색이다.
import { LEDGER_LIMIT, describeTransaction } from '../../lib/pointService';

/**
 * @param {'loading'|'ready'|'error'} state  잔액과 독립적으로 실패할 수 있어 상태를 따로 받는다
 * @param {Array<object>} rows  fetchMyPointLedger() 결과 (created_at 내림차순)
 */
export default function PointLedger({ state, rows = [] }) {
  return (
    <section className="ledger" aria-label="포인트 내역">
      <div className="lhead">
        <h4 className="fl">포인트 내역</h4>
        {state === 'ready' && rows.length > 0 && <span className="lnote">최근 {LEDGER_LIMIT}건</span>}
      </div>

      {state === 'loading' && <div className="empty">포인트 내역을 불러오는 중…</div>}

      {/* [빈 상태와 실패를 같은 문구로 쓰지 않는다] 0건은 사실이고 실패는 "아직 모르는 상태"다. */}
      {state === 'error' && (
        <div className="empty" role="alert">
          포인트 내역을 불러오지 못했어요.
          <br />
          잠시 후 다시 시도해 주세요.
        </div>
      )}

      {state === 'ready' &&
        (rows.length === 0 ? (
          <div className="empty">
            아직 포인트 내역이 없습니다.
            <br />
            활동에 참여하고 QR 인증을 완료하면 이곳에 기록됩니다.
          </div>
        ) : (
          <ul className="llist">
            {rows.map((tx) => {
              const v = describeTransaction(tx);
              return (
                <li key={tx.id} className="lrow">
                  <span className={`ltag ${v.earned ? 'earn' : 'conv'}`}>{v.typeLabel}</span>
                  <div className="lmain">
                    {/* 전환 행은 활동명이 없다(related_participation_id 가 NULL — DB CHECK).
                        적립인데 프로그램을 못 읽은 건은 "게시가 중단된 프로그램"으로 뜨고 행이 사라지지 않는다. */}
                    <div className="lt">{v.title}</div>
                    <div className="ld">{v.dateLabel}</div>
                  </div>
                  <div className={`lamt ${v.earned ? 'earn' : 'conv'}`}>{v.amountLabel}</div>
                </li>
              );
            })}
          </ul>
        ))}
    </section>
  );
}
