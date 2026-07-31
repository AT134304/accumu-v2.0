// Accumu v2 — 포인트 → 지역화폐 전환 모달 (docs/specs/student-archive-mypage.md B-3 / 확정 F·G)
// Accumu_prototype.html openConvert()(1209~1237줄)의 구조·카피를 재현한다.
//
// [절대 원칙 3 — 이 모달이 그 원칙을 화면으로 말하는 자리다]
//   1. 결제·계좌·외부 API 호출 0줄. 서버 RPC 는 profiles 잔액 이동 + 원장 1행이 전부다.
//   2. 시뮬레이션 고지와 "되돌릴 수 없습니다" 두 줄은 삭제·축약 금지(스펙 B-3 / ADR 0007 구현 가이드 6번).
//   3. 잔액을 프런트가 빼지 않는다. 차감 후 값은 RPC 응답에서 온다.
//
// [프로토타입과 다른 점]
//   - 프리셋을 [1000,3000,5000,10000] -> [500,1000,3000] 으로 낮췄다(확정 F). 데모 잔액이 수백~수천P라
//     원본 눈금으로는 칩이 하나도 뜨지 않고 매번 fallback 을 탄다.
//   - 성공 토스트에서 이모지를 뺐다(원본 1244줄 '💸'). CLAUDE.md 8장 — 토스트는 duotone 체크 아이콘이다.
//   - 실패 시 모달을 닫지 않는다. 잔액 부족·권한 오류·네트워크가 각각 다른 문구를 갖는다(스펙 에러 처리 표).
import { useState } from 'react';
import Modal from '../Modal';
import Icon from '../Icon';
import { useAuth } from '../../context/AuthContext';
import { CONVERT, convertFailText, convertOptions, convertToCurrency } from '../../lib/pointService';

/**
 * @param {number}   balance    현재 points_balance (AuthContext 의 profile 값 — 프런트 계산값이 아니다)
 * @param {Function} onClose    모달 닫기
 * @param {Function} onSuccess  async (amount) => void. 전환 성공 시 부모가 닫기 + 토스트 + 내역 갱신을 맡는다
 */
export default function ConvertModal({ balance, onClose, onSuccess }) {
  // 전환 성공/거부 모두 서버가 최신 잔액 3종을 응답에 실어 준다 -> 전역 profile 을 그 값으로 덮는다(이슈 3).
  const { applyProfilePatch, refreshProfile } = useAuth();
  const [picked, setPicked] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const avail = Number(balance ?? 0);
  const options = convertOptions(avail);
  // 잔액이 줄면(거부 후 갱신 등) 이전 선택이 목록에서 사라진다 — 그때는 조용히 첫 칩으로 돌아간다.
  const amount = options.includes(picked) ? picked : options[0] ?? 0;

  /* [빈 상태 — 정상 UI 에서는 도달하지 않는다]
     마이페이지의 전환 버튼이 잔액 < 100P 에서 비활성이라(기능 요구사항) 여기까지 오지 않는다.
     그래도 남겨두는 이유: 모달이 열려 있는 동안 다른 탭에서 잔액이 줄 수 있고, 그때 칩이 0개인
     전환 화면을 보여주는 것보다 사실을 말하는 편이 낫다. 프로토타입 1216~1217줄 카피 그대로. */
  if (options.length === 0) {
    return (
      <Modal onClose={onClose} labelledBy="convert-title">
        <div className="mbody conv-modal">
          <span className="mtag">포인트 전환</span>
          <h3 id="convert-title">전환할 포인트가 없어요</h3>
          <p className="desc">프로그램에 참여해 포인트를 모으면 지역화폐로 전환할 수 있어요.</p>
          <button type="button" className="mbtn" onClick={onClose}>
            확인
          </button>
        </div>
      </Modal>
    );
  }

  async function handleConvert() {
    // [더블클릭 방어는 프런트의 몫이다] 전환은 멱등이 아니다 — 두 번 호출되면 두 번 차감되는 것이
    // 정상 도메인이라 서버가 막아주지 않는다(ADR 0007 결정 3-5).
    if (busy || amount <= 0) return;
    setBusy(true);
    setError('');

    const result = await convertToCurrency(amount);

    if (result.outcome === CONVERT.SUCCESS) {
      applyProfilePatch({
        points_balance: result.points_balance,
        points_total: result.points_total, // 누적은 전환으로 줄지 않는다 — 서버 값을 그대로 확인하는 셈이다
        currency_balance: result.currency_balance,
      });
      // busy 를 풀지 않고 넘긴다. 부모가 곧 언마운트하므로 그 사이 두 번째 호출이 끼지 못한다.
      await onSuccess(result.amount);
      return;
    }

    if (result.outcome === CONVERT.REJECTED) {
      // 잔액 부족 = 도메인 실패. 응답에 실린 최신 잔액으로 화면을 맞춘 뒤 모달은 열어둔다.
      applyProfilePatch({
        points_balance: result.points_balance,
        points_total: result.points_total,
        currency_balance: result.currency_balance,
      });
    } else if (result.errorKind === 'network') {
      // 성공 여부가 불확실하다 — 차감됐는데 응답만 못 받았을 수 있으므로 반드시 재조회한다(스펙 에러 처리 표).
      await refreshProfile();
    }

    setError(convertFailText(result));
    setBusy(false);
  }

  return (
    <Modal onClose={onClose} labelledBy="convert-title">
      <div className="mbody conv-modal">
        <span className="mtag">포인트 전환</span>
        <h3 id="convert-title">지역화폐로 전환</h3>
        <p className="desc">
          모은 포인트를 지역화폐로 전환합니다. <b>1P = 1원</b>이며, 전환한 만큼 포인트가 차감됩니다.
        </p>

        <div className="convbal">
          <span>전환 가능 포인트</span>
          <b>{avail.toLocaleString()} P</b>
        </div>

        <div className="amtgrid">
          {options.map((v, i) => {
            const isFull = i === options.length - 1; // 마지막 항목이 언제나 "전액 전환"이다(convertOptions)
            return (
              <button
                key={v}
                type="button"
                className={`amt${isFull ? ' full' : ''}${v === amount ? ' on' : ''}`}
                aria-pressed={v === amount}
                disabled={busy}
                onClick={() => setPicked(v)}
              >
                {isFull ? `전액 전환 · ${v.toLocaleString()}P` : `${v.toLocaleString()}P`}
              </button>
            );
          })}
        </div>

        <div className="convresult">
          <span>받을 지역화폐</span>
          <strong>₩ {amount.toLocaleString()}</strong>
        </div>

        <button type="button" className="mbtn" disabled={busy} onClick={handleConvert}>
          <Icon name="ic-coin" size={18} />
          {busy ? '전환 중…' : `₩${amount.toLocaleString()} 지역화폐로 전환하기`}
        </button>

        {error && (
          <div className="join-err" role="alert">
            {error}
          </div>
        )}

        {/* [삭제·축약 금지 — 확정 F·G] 첫 줄은 프로토타입 1235줄 카피 그대로(절대 원칙 3을 화면이 스스로
            말하는 자리), 둘째 줄은 취소·환급 경로가 없다는 사실 고지다(결정 G — 되돌리려면 원장 역행이 필요하다). */}
        <div className="convnote">
          ※ 프로토타입에서는 실제 지역화폐 계좌로 연동되지 않으며, 전환 결과만 표시됩니다.
          <br />
          전환한 포인트는 되돌릴 수 없습니다.
        </div>
      </div>
    </Modal>
  );
}
