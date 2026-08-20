// Accumu v2 — 프로그램 신고 패널 (ADR 0025)
//
// [별도 모달이 아니라 참여 팝업 안의 패널인 이유]
//   Modal 은 포커스 트랩을 건다. 모달 위에 모달을 띄우면 트랩이 두 겹이 되고, Esc 가 어느 쪽을
//   닫는지도 애매해진다(ImageCropper 를 ProgramFormModal 안의 패널로 만든 것과 같은 판단).
//
// [★ 시각적으로 작게 둔다 — 원칙 4의 연장]
//   신고는 필요한 기능이지만 이 화면의 주인공이 아니다. 참여 신청 버튼보다 크거나 먼저 읽히면
//   "신고하는 앱"이 된다. 그래서 진입은 본문 맨 아래의 작은 텍스트 버튼 하나다.
//
// [신고 수·결과를 보여주지 않는다] 몇 명이 신고했는지, 내 신고로 내려갔는지 알려주지 않는다.
//   >>> reportService.js 상단의 "이 파일이 절대 하지 않는 것" 3가지와 같은 규율이다.
import { useState } from 'react';
import Icon from '../Icon';
import {
  REPORT_DETAIL_MAX,
  REPORT_DETAIL_MIN,
  REPORT_REASONS,
  reportProgram,
} from '../../lib/reportService';

/**
 * @param {string}   programId
 * @param {Function} onReported  신고 접수 성공 시 호출 (호출부가 "신고됨" 상태로 바꾼다)
 * @param {Function} onCancel    패널 닫기
 */
export default function ReportPanel({ programId, onReported, onCancel }) {
  const [reason, setReason] = useState('');
  const [detail, setDetail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const trimmed = detail.trim();
  // [★ 이유는 사유 종류와 무관하게 필수다 — 2026-08-21]
  //   전에는 '기타'일 때만 요구했다. 나머지는 클릭 한 번이면 신고가 됐고, 그게 장난 신고의 비용이었다.
  //   >>> 사유별로 필수 여부를 다시 가르지 말 것. 갈리는 순간 가장 싼 사유로 신고가 몰린다.
  const detailShort = trimmed.length < REPORT_DETAIL_MIN;
  const blocked = !reason || busy || detailShort;

  async function handleSubmit() {
    if (blocked) return;
    setBusy(true);
    setError('');
    const result = await reportProgram({ programId, reason, detail: trimmed });
    if (result.ok) {
      onReported?.();
      return; // busy 를 풀지 않는다 — 호출부가 곧 다시 그린다(중복 제출 방지)
    }
    setError(result.message);
    setBusy(false);
  }

  return (
    <div className="reportpanel">
      <div className="rp-head">
        <Icon name="ic-alert" size={15} />
        <b>어떤 점이 문제인가요?</b>
      </div>

      {/* [사유는 라디오다 — 복수 선택을 만들지 않는다] 여러 개를 고를 수 있으면 "전부 체크"가 기본
          행동이 되고 사유 자체가 정보를 잃는다. */}
      <div className="rp-reasons" role="radiogroup" aria-label="신고 사유">
        {REPORT_REASONS.map((r) => (
          <button
            key={r.key}
            type="button"
            role="radio"
            aria-checked={reason === r.key}
            className={reason === r.key ? 'rp-reason on' : 'rp-reason'}
            disabled={busy}
            onClick={() => {
              setReason(r.key);
              setError('');
            }}
          >
            <span className="rp-dot" aria-hidden="true" />
            <span className="rp-rtext">
              <b>{r.label}</b>
              <em>{r.hint}</em>
            </span>
          </button>
        ))}
      </div>

      <div className="rp-head">
        <b>어떤 상황이었는지 적어주세요</b>
        <em>필수 · {REPORT_DETAIL_MIN}자 이상</em>
      </div>
      <textarea
        className="rp-detail"
        rows={4}
        maxLength={REPORT_DETAIL_MAX}
        placeholder="언제, 무엇이 공고와 달랐는지 구체적으로 적어주세요."
        value={detail}
        disabled={busy}
        onChange={(e) => {
          setDetail(e.target.value);
          setError('');
        }}
      />
      {/* 남은 글자 수를 "게이지"로 그리지 않는다(원칙 1) — 문장 하나로 말한다. */}
      <div className={detailShort ? 'rp-hint short' : 'rp-hint'}>
        {detailShort ? `${REPORT_DETAIL_MIN - trimmed.length}자 더 써주세요` : `${trimmed.length}자`}
      </div>

      {/* 신고가 무엇을 하는지 정확히 말한다 — "관리자가 처벌된다"로 오해되지 않게.
          동시에 남용을 막는 문장이기도 하다(취소가 없다는 사실을 미리 알린다). */}
      <p className="rp-note">
        신고는 <b>관리자에게 전달되지 않고</b>, 같은 신고가 여러 건 쌓이면 프로그램이 자동으로
        내려갑니다. 누가 신고했는지도, 적은 내용도 관리자에게 보이지 않아요.{' '}
        <b>접수 후에는 취소할 수 없습니다.</b>
      </p>

      <div className="rp-acts">
        <button type="button" className="rp-cancel" onClick={onCancel} disabled={busy}>
          그만두기
        </button>
        <button type="button" className="rp-submit" onClick={handleSubmit} disabled={blocked}>
          {busy ? '접수 중…' : '신고 접수'}
        </button>
      </div>

      {error && (
        <div className="join-err" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
