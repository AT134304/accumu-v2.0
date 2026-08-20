-- Accumu v2 — report_reason enum 확장 (ADR 0026 선행 마이그레이션)
--
-- [★ 이 파일이 따로 있는 이유 — notification_type 과 같은 함정]
--   Postgres 는 "같은 트랜잭션에서 추가한 enum 값을 그 트랜잭션 안에서 사용"하는 것을 금지한다(55P04).
--   Supabase SQL Editor 는 붙여넣은 스크립트 전체를 **한 트랜잭션**으로 실행하므로,
--   `alter type ... add value` 와 그 값을 쓰는 문장이 같은 파일에 있으면 반드시 실패한다.
--
--   다음 파일(20260822120000)은 CHECK 제약 안에서 이 값들을 직접 쓴다:
--     check (... reason in ('irrelevant', 'paid', 'inappropriate') ...)
--   **CHECK·인덱스 술어·DML 이 위험하다.** 함수 본문(plpgsql)은 런타임 해석이라 걸리지 않지만,
--   여기서는 CHECK 가 있으므로 값 추가를 먼저 커밋시켜야 한다.
--
--   >>> 규율: report_reason 에 값을 더할 일이 생기면 **이 파일에 한 줄 추가하고 단독 실행**할 것.
--       다른 마이그레이션 안에 alter type 을 섞지 말 것.
--
-- [실행 순서]
--   1) 이 파일        (enum 값 커밋)
--   2) 20260822120000 (신고 2분류 + 게시 게이트)
--   재실행해도 안전하다(if not exists).

-- ---------------------------------------------------------
-- 원본 5종 (20260821140000):
--   not_real / mismatch / irrelevant / paid / other
-- ---------------------------------------------------------

-- [공개 신고 — 공고만 봐도 판단할 수 있다]
--   케빈, 2026-08-21: "부적절한 내용처럼 참여하지 않아도 딱 보면 바로 알 수 있는 것 같은 건 바로 신고"
--   기존 irrelevant(진로 활동 아님) / paid(유료) 와 같은 성격이라 같은 칸에 들어간다.
alter type public.report_reason add value if not exists 'inappropriate';

-- [참여자 전용 신고 — 겪어봐야 안다]
--   같은 대화: "시간엄수와 같은건 참여 한 학생만 가능하게"
--   기존 not_real(안 열림) / mismatch(설명과 다름) 과 같은 성격이다.
alter type public.report_reason add value if not exists 'unpunctual';

comment on type public.report_reason is
  '프로그램 신고 사유 7종. [공개 — 공고만 봐도 판단 가능] irrelevant=진로·커리어 활동이 아니다(원칙 2), '
  'paid=참여에 비용이 든다, inappropriate=부적절한 내용. '
  '[참여자 전용 — 겪어야 안다] not_real=실제로 열리지 않았다, mismatch=설명과 실제가 다르다, '
  'unpunctual=시간이 지켜지지 않았다, other=기타. '
  '[other 가 참여자 전용인 이유] 공개 신고는 "명백히 보이는 것"만 허용하는데 기타는 정의상 명백하지 않다. '
  '공개로 두면 참여자 전용 사유를 "기타"로 우회하는 구멍이 된다. '
  '>>> 분류의 소유자는 report_my_program() 의 case 문이다(20260822120000).';
