// Accumu v2 — 만족도 평가 폼 (별점 + 한줄평). docs/specs/student-archive-mypage.md 결정 D / C절
//
// [폼은 하나뿐이다 — 복제 금지] 퇴장 인증 완료 화면(QrCenterModal)과 아카이브 활동 상세 모달이
//   같은 이 컴포넌트를 쓴다. 두 개로 나누면 별점 필수·60자 상한·빈 값 null 규칙이 갈라진다
//   (admin-programs 확정 A 와 같은 규율).
//
// [원칙 1 가드]
//   - 평가를 남겨도 포인트·뱃지·보상이 없다. 이 파일에 포인트를 다루는 코드가 없다.
//   - 평균 별점·리뷰 수·"평가 완료율"을 만들지 않는다(정책상 남의 리뷰를 읽을 수도 없다).
//   - 별 색 amber 는 CLAUDE.md 2장 1번이 명시적으로 허용한 요소다(포인트 표시가 아니다).
import { useState } from 'react';
import Icon from '../Icon';
import { REVIEW_COMMENT_MAX, upsertMyReview } from '../../lib/reviewService';
import '../../styles/Review.css';

/** 별점 라벨 5종 — 프로토타입 RATE_TXT(1067줄) 그대로. 인덱스 0 은 미선택 상태다. */
const RATE_TXT = ['별점을 선택해 주세요', '별로였어요', '아쉬웠어요', '보통이었어요', '좋았어요', '최고였어요!'];

/**
 * @param {string}   participationId  평가 대상 참여 id (리뷰의 소유자는 이 값으로 결정된다)
 * @param {string}   [title]          활동명 — heading 이 true 일 때만 쓴다
 * @param {object}   [review]         기존 리뷰 { rating, comment } — 있으면 수정 모드
 * @param {Function} onSaved          (review) => void. 저장 성공 시 호출(모달 닫기·목록 갱신은 호출부 몫)
 * @param {Function} [onSkip]         건너뛰기/취소. 없으면 버튼이 뜨지 않는다
 * @param {string}   [skipLabel]      기본 '건너뛰기'
 * @param {boolean}  [heading]        태그·제목·활동명 머리글을 그릴지 (QR 완료 화면 true / 상세 모달 false)
 */
export default function ReviewForm({
  participationId,
  title,
  review = null,
  onSaved,
  onSkip,
  skipLabel = '건너뛰기',
  heading = true,
}) {
  const [rating, setRating] = useState(review?.rating ?? 0);
  const [comment, setComment] = useState(review?.comment ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit() {
    if (busy) return;
    // 별점은 필수다(스펙 D-3). 서버 CHECK 도 1~5 를 요구하므로 여기서 막지 않으면 23514 가 된다.
    if (!rating) {
      setError('별점을 먼저 선택해 주세요.');
      return;
    }
    setBusy(true);
    setError('');
    const result = await upsertMyReview({ participationId, rating, comment });
    if (result.ok) {
      // 성공 시 busy 를 풀지 않는다 — 호출부가 곧 닫거나 다시 그린다(중복 제출 방지).
      onSaved?.(result.review);
      return;
    }
    // 실패해도 모달을 닫지 않고 입력값을 그대로 둔다(스펙 에러 처리 표).
    setError(result.message);
    setBusy(false);
  }

  return (
    <div className="survey">
      {heading && (
        <>
          <span className="mtag rate">만족도 평가</span>
          <h3 className="survey-title">활동은 어떠셨나요?</h3>
          {title && <div className="survey-sub">{title}</div>}
        </>
      )}

      <div className="stars" role="group" aria-label="별점">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            className={n <= rating ? 'star on' : 'star'}
            aria-label={`${n}점`}
            aria-pressed={n === rating}
            disabled={busy}
            onClick={() => {
              setRating(n);
              setError('');
            }}
          >
            <Icon name="ic-star" size={28} color={n <= rating ? 'var(--amber)' : '#D7DEEA'} />
          </button>
        ))}
      </div>
      <div className="ratelabel">{RATE_TXT[rating]}</div>

      <textarea
        className="reviewinput"
        rows={2}
        maxLength={REVIEW_COMMENT_MAX}
        placeholder="한 줄 평을 남겨보세요 (선택) · 포트폴리오에 함께 기록됩니다"
        value={comment}
        disabled={busy}
        onChange={(e) => setComment(e.target.value)}
      />
      <div className="revcount">
        {comment.length}/{REVIEW_COMMENT_MAX}
      </div>

      <button type="button" className="mbtn survey-submit" onClick={handleSubmit} disabled={busy}>
        {busy ? '저장 중…' : review ? '평가 수정하기' : '평가 제출하기'}
      </button>

      {/* [건너뛰기는 필수다 — 스펙 D-2] 평가를 강제하면 QR 흐름의 마지막 단계가 막힌다.
          건너뛴 활동은 아카이브에서 "평가 미작성"으로 남고 언제든 작성할 수 있다. */}
      {onSkip && (
        <button type="button" className="skipbtn" onClick={onSkip} disabled={busy}>
          {skipLabel}
        </button>
      )}

      {error && (
        <div className="join-err" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

/** 별 미니(표시 전용) — 아카이브 활동 행의 평가 줄. 클릭 대상이 아니라 상태 표시다. */
export function StarsMini({ rating = 0, size = 13 }) {
  return (
    <span className="smini" aria-label={`별점 ${rating}점`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Icon key={n} name="ic-star" size={size} color={n <= rating ? 'var(--amber)' : '#D7DEEA'} />
      ))}
    </span>
  );
}
