-- Accumu v2 — notification_type enum 확장 (ADR 0013 선행 마이그레이션)
--
-- [★ 이 파일이 따로 있는 이유 — 반드시 읽을 것]
--   Postgres 는 "같은 트랜잭션에서 추가한 enum 값을 그 트랜잭션 안에서 사용"하는 것을 금지한다(55P04).
--   Supabase SQL Editor 는 붙여넣은 스크립트 전체를 **한 트랜잭션**으로 실행하므로,
--   `alter type ... add value` 와 그 값을 쓰는 문장이 같은 파일에 있으면 반드시 실패한다.
--
--   실제로 걸린 곳은 부분 인덱스의 술어였다(2026-08-08):
--     create unique index ... where type = 'stale';   -- 55P04: unsafe use of new value "stale"
--   함수 본문(plpgsql)은 문자열이 런타임에 해석되므로 걸리지 않는다. **인덱스 술어·CHECK·DML 이 위험하다.**
--
--   >>> "실패하면 한 번 더 실행하면 된다" 는 통하지 않는다. 오류가 트랜잭션을 통째로 되돌리면서
--       alter type 까지 함께 취소되기 때문이다. 그래서 값 추가를 **먼저 커밋**시켜야 한다.
--
--   >>> 규율: notification_type 에 값을 더할 일이 생기면 **이 파일에 한 줄 추가하고 단독 실행**할 것.
--       다른 마이그레이션 안에 alter type 을 섞지 말 것.
--
-- [실행 순서]
--   1) 이 파일        (enum 값 커밋)
--   2) 20260808120000 (관리자 알림 + 전환 알림)
--   3) 20260808140000 (내일 예정·퇴장 미완료 알림 + 가입/연동 구분)
--   4) 20260811200000 (대기열 승격 알림, ADR 0018 — 'promoted' 값이 필요하다)
--   5) 20260811220000 (프로그램 일정 변경 알림, ADR 0018 — 'rescheduled' 값이 필요하다)
--   6) 20260821140000 (학생 신고 자동 게시중단, ADR 0025 — 'reported' 값이 필요하다)
--
--   재실행해도 안전하다(if not exists). >>> 이 파일이 이미 적용된 환경에서 새 값을 추가했다면,
--   파일 전체를 다시 한 번(단독으로) 실행하기만 하면 된다 — 기존 값들은 add value if not exists라
--   재적용이 안전하고, 새로 추가된 줄만 실제로 커밋된다.

-- ---------------------------------------------------------
-- 원본 4종 (20260806120000): new / apply / enter / exit
-- ---------------------------------------------------------

-- 학생 — 지역화폐 전환 완료 (ADR 0012 정산과 같은 트랜잭션에서 생성)
alter type public.notification_type add value if not exists 'convert';

-- 관리자 — 내가 올린 프로그램에 새 신청 (학생 이름을 담지 않는다. ADR 0013 결정 3)
alter type public.notification_type add value if not exists 'apply_admin';

-- 관리자 — 담당 학생 추가 (가입 경로 / 마이페이지 연동 경로를 문구로 구분)
alter type public.notification_type add value if not exists 'mentee';

-- 관리자 — 일정이 지났는데 아직 게시중 ("내려도 괜찮아요")
alter type public.notification_type add value if not exists 'stale';

-- 학생 — 내일 참여 예정
alter type public.notification_type add value if not exists 'upcoming';

-- 관리자 — 내일 진행 예정 (QR 스캔 준비)
alter type public.notification_type add value if not exists 'upcoming_admin';

-- 학생 — 입장은 했는데 퇴장 인증이 없다 (그 상태로는 포인트가 지급되지 않는다)
alter type public.notification_type add value if not exists 'exit_due';

-- ---------------------------------------------------------
-- ADR 0018 (2026-08-11) — 대기열 승격 알림
-- ---------------------------------------------------------

-- 학생 — 대기 중이던 자리가 취소로 비어 자동 승격됨(cancel_my_participation, 20260811200000)
alter type public.notification_type add value if not exists 'promoted';

-- 학생 — 신청/대기 중인 프로그램의 일정(날짜·시간·진행일)이 관리자 수정으로 바뀜(20260811220000)
alter type public.notification_type add value if not exists 'rescheduled';

-- 관리자 — 내 프로그램이 신고 누적으로 자동 게시중단됨 (ADR 0025)
--   [신고자를 알려주지 않는다] 메시지에 학생 이름·수·사유가 들어가지 않는다. 관리자가 신고자를
--   특정할 수 있으면 보복 경로가 생기고, 그 순간 신고 기능 자체가 죽는다.
alter type public.notification_type add value if not exists 'reported';
