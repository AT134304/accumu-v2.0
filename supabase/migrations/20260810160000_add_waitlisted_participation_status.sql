-- Accumu v2 — participation_status enum 확장: 'waitlisted' (ADR 0016 선행 마이그레이션)
--
-- [★ 이 파일이 따로 있는 이유 — 20260808100000 과 같은 사유]
--   Postgres 는 "같은 트랜잭션에서 추가한 enum 값을 그 트랜잭션 안에서 사용"하는 것을 금지한다(55P04).
--   Supabase SQL Editor 는 붙여넣은 스크립트 전체를 한 트랜잭션으로 실행하므로, alter type ... add value
--   와 그 값을 쓰는 문장(트리거 본문의 CASE/비교, 부분 인덱스, RLS with check 등)이 같은 파일에 있으면
--   반드시 실패한다. 값 추가를 먼저 커밋시켜야 한다.
--
--   >>> 규율: participation_status 에 값을 더할 일이 또 생기면 이 파일에 한 줄 추가하고 단독 실행할 것.
--       다른 마이그레이션 안에 alter type 을 섞지 말 것.
--
-- [배경] 케빈 요청(2026-08-10): "정원이 차면 자동으로 신청 아이콘이 대기로 바뀌게 해줘."
--   ADR 0006 결정 2는 신청을 applied/entered/completed 3종으로만 다뤘고, 정원이 차면 신청 자체를
--   거부했다(그 ADR의 "재검토 시점"이 예고한 바로 그 상황 — 대기열이 생기면 다시 본다).
--   'waitlisted' 는 "신청은 접수됐지만 정원 안에 들지 못해 자리를 기다리는 중"이다.
--
-- [실행 순서]
--   1) 이 파일        (enum 값 커밋)
--   2) 20260810180000 (취소 + 대기열 자동 전환 + 신청자 수 RPC)
--
-- 재실행해도 안전하다(if not exists).

alter type public.participation_status add value if not exists 'waitlisted';

comment on type public.participation_status is
  '한 학생의 참여 진행도. applied=신청함(자리 확보) -> entered=입장 인증 완료 -> completed=퇴장 인증 완료. '
  'waitlisted=신청은 접수됐지만 정원이 차 대기 중(ADR 0016) — QR 발급 대상이 아니다(자리가 없다). '
  '누군가 취소하면 cancel_my_participation() 이 가장 먼저 신청한 waitlisted 행 하나를 applied 로 승격한다. '
  '[주의] programs.status(program_status)와 다른 개념이다 — 저쪽은 프로그램의 모집 상태, 이쪽은 학생 개인의 진행도. '
  'applied/waitlisted 전이는 participations_capacity_guard 트리거(insert 시점)와 cancel_my_participation() '
  '(승격)이, entered/completed 전이는 verify_participation_qr() 이 담당한다 — participations 에 학생·관리자용 '
  'update 정책은 여전히 0개다.';
